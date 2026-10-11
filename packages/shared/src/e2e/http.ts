/**
 * 经端到端通道发 HTTP/1.1 请求，答一个标准的 `Response`（设计 §4.6）：请求行与头由
 * 这里编码（协议包 `http1`），一条内层流一个请求（`connection: close`），响应头
 * 解析完就答，体按内层流的窗口流式交给 `Response.body`——大文件下载不进内存，背压
 * 一路传回 core。
 *
 * 只认绝对地址；调用方（`apps/web` 的通道管理）只把发往这个源的请求交过来。
 * `AbortSignal` 触发时重置这条内层流。
 */

import {
  type HeaderPair,
  ResponseParser,
  encodeRequestHead,
  requestFraming,
} from "@armadra/platform-protocol/http1";

import type { E2eClientChannel } from "./channel.js";
import { type InnerStream, RST_CODE } from "./mux.js";

/** 由这里决定、不让调用方带的头（逐跳头与 Host）。 */
const DROPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
]);

/** 没有体的状态（`Response` 的构造器不收体）。 */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export interface ChannelFetchOptions {
  /** 内层请求带的 `Origin`（页面自己的来源）；`null` = 不带。 */
  readonly origin: string | null;
  /**
   * 这个源在中继上的基址（`https://<中继>/s/<sourceId>` 或 saas 的子域）：它的路径
   * 前缀是中继的路由，不属于 core，内层请求里去掉。
   */
  readonly base?: string;
}

/** 绝对地址 → core 眼里的路径（去掉基址的路径前缀，带 query）。 */
export function innerPath(url: URL, base: string | undefined): string {
  let pathname = url.pathname;
  if (base !== undefined && base !== "") {
    const prefix = new URL(base).pathname.replace(/\/+$/, "");
    if (
      prefix !== "" &&
      (pathname === prefix || pathname.startsWith(`${prefix}/`))
    )
      pathname = pathname.slice(prefix.length) || "/";
  }
  return `${pathname}${url.search}`;
}

/** 读出整个请求体（上传按页面自己的分块，每块不大；下载才需要流式）。 */
async function requestBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return null;
  return new Uint8Array(await request.arrayBuffer());
}

export function channelFetch(
  channel: E2eClientChannel,
  options: ChannelFetchOptions,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = init?.signal ?? request.signal;
    if (signal?.aborted) throw abortError();
    const url = new URL(request.url);
    const path = innerPath(url, options.base);
    const method = request.method.toUpperCase();
    const body = await requestBody(request);
    const headers: HeaderPair[] = [["host", url.host]];
    let hasOrigin = false;
    request.headers.forEach((value, name) => {
      if (DROPPED.has(name)) return;
      if (name === "origin") hasOrigin = true;
      headers.push([name, value]);
    });
    if (!hasOrigin && options.origin !== null)
      headers.push(["origin", options.origin]);
    headers.push(["connection", "close"]);
    if (body !== null) headers.push(["content-length", String(body.length)]);
    const framing = requestFraming(headers, body !== null);

    let stream: InnerStream;
    try {
      stream = channel.mux.open("http", method, path);
    } catch (error) {
      throw new TypeError(`端到端通道不可用：${String(error)}`);
    }
    const onAbort = () => stream.reset(RST_CODE.clientGone);
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    try {
      await stream.write(encodeRequestHead(method, path, headers, framing));
      if (body !== null && body.length > 0) await stream.write(body);
      // 不在这里半关：服务器见到对端 END 会提前收掉还在流式写的响应。响应收全之后
      // 再 END（请求有 Content-Length，服务器不靠 END 判断请求体结束）。

      const parser = new ResponseParser({ method });
      const early: Uint8Array[] = [];
      let ended = false;
      let head: {
        status: number;
        statusText: string;
        headers: HeaderPair[];
      } | null = null;
      while (head === null) {
        const chunk = await stream.read();
        const events = chunk === null ? parser.finish() : parser.feed(chunk);
        for (const event of events) {
          if (event.type === "head") head = event.head;
          else if (event.type === "body") early.push(event.bytes);
          else if (event.type === "end") ended = true;
        }
        if (chunk === null && head === null) throw new TypeError("响应没收全");
      }
      const responseHeaders = new Headers();
      for (const [name, value] of head.headers) {
        try {
          responseHeaders.append(name, value);
        } catch {
          /* 浏览器不让设的头（禁改头）略过。 */
        }
      }
      const nullBody = NULL_BODY.has(head.status) || method === "HEAD";
      let bodyStream: ReadableStream<Uint8Array> | null = null;
      if (nullBody) {
        if (ended) stream.end();
        else stream.reset(RST_CODE.clientGone);
        cleanup();
      } else {
        bodyStream = new ReadableStream<Uint8Array>(
          {
            pull: async (controller) => {
              for (;;) {
                const pending = early.shift();
                if (pending !== undefined) {
                  controller.enqueue(pending);
                  return;
                }
                if (ended) {
                  cleanup();
                  stream.end();
                  controller.close();
                  return;
                }
                let chunk: Uint8Array | null;
                try {
                  chunk = await stream.read();
                } catch (error) {
                  cleanup();
                  controller.error(
                    signal?.aborted
                      ? abortError()
                      : new TypeError(String(error)),
                  );
                  return;
                }
                const events =
                  chunk === null ? parser.finish() : parser.feed(chunk);
                for (const event of events) {
                  if (event.type === "body") early.push(event.bytes);
                  else if (event.type === "end") ended = true;
                }
                if (chunk === null && !ended) {
                  cleanup();
                  controller.error(new TypeError("响应体没收全"));
                  return;
                }
              }
            },
            cancel: () => {
              cleanup();
              stream.reset(RST_CODE.clientGone);
            },
          },
          { highWaterMark: 0 },
        );
      }
      const response = new Response(bodyStream, {
        status: head.status,
        statusText: head.statusText,
        headers: responseHeaders,
      });
      Object.defineProperty(response, "url", { value: request.url });
      return response;
    } catch (error) {
      cleanup();
      stream.reset(RST_CODE.clientGone);
      if (signal?.aborted) throw abortError();
      if (error instanceof TypeError) throw error;
      throw new TypeError(`经端到端通道的请求失败：${String(error)}`);
    }
  };
}
