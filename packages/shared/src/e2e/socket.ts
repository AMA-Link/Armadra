/**
 * 经端到端通道开的 WebSocket（设计 §4.6、§4.12）：一个与浏览器 `WebSocket` 同形的类，
 * 一条内层流一条连接。升级请求与 `101` 由这里编解码（协议包 `http1`），之后按
 * RFC 6455 收发帧（协议包 `ws-frames`；客户端帧带掩码）。
 *
 * `apps/web` 把这个类当成「底层 WebSocket」交给 `ticketedWebSocket` 与 `ManagedSocket`：
 * 换票、退避、关闭码语义都不变，只是字节走通道。
 */

import {
  type HeaderPair,
  ResponseParser,
  serializeRequestHead,
} from "@armadra/platform-protocol/http1";
import {
  OPCODE,
  WsFrameDecoder,
  closePayload,
  encodeWsFrame,
} from "@armadra/platform-protocol/ws-frames";

import type { E2eClientChannel } from "./channel.js";
import { innerPath } from "./http.js";
import { type InnerStream, RST_CODE } from "./mux.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function acceptKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-1",
    encoder.encode(`${key}${GUID}`),
  );
  return base64(new Uint8Array(digest));
}

function header(headers: readonly HeaderPair[], name: string): string {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
}

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  if (typeof CloseEvent === "function")
    return new CloseEvent("close", { code, reason, wasClean });
  return Object.assign(new Event("close"), { code, reason, wasClean });
}

type SocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

export interface ChannelSocketOptions {
  /** 升级请求带的 `Origin`；`null` = 不带。 */
  readonly origin: string | null;
  /** 这个源在中继上的基址（见 `ChannelFetchOptions.base`）。 */
  readonly base?: string;
}

/** 造一个绑在这条通道上的 `WebSocket` 类。 */
export function channelWebSocket(
  channel: E2eClientChannel,
  options: ChannelSocketOptions,
): typeof WebSocket {
  class ChannelWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    readonly extensions = "";
    protocol = "";
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    private stream: InnerStream | null = null;
    private closeSent = false;
    private finished = false;
    /** 写按顺序排队（帧不能交错）。 */
    private writing: Promise<void> = Promise.resolve();

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = new URL(url).href;
      const offered =
        protocols === undefined
          ? []
          : Array.isArray(protocols)
            ? protocols
            : [protocols];
      void this.connect(offered);
    }

    private emit(name: "open" | "message" | "error" | "close", event: Event) {
      const handler = this[`on${name}`] as ((event: Event) => void) | null;
      handler?.call(this, event);
      this.dispatchEvent(event);
    }

    private async connect(offered: string[]): Promise<void> {
      const target = new URL(this.url);
      const path = innerPath(target, options.base);
      let stream: InnerStream;
      try {
        stream = channel.mux.open("ws", "GET", path);
      } catch {
        this.abort(1006, "");
        return;
      }
      this.stream = stream;
      const key = base64(randomBytes(16));
      const headers: HeaderPair[] = [
        ["host", target.host],
        ...(options.origin === null
          ? []
          : ([["origin", options.origin]] as HeaderPair[])),
        ["upgrade", "websocket"],
        ["connection", "Upgrade"],
        ["sec-websocket-key", key],
        ["sec-websocket-version", "13"],
        ...(offered.length === 0
          ? []
          : ([["sec-websocket-protocol", offered.join(", ")]] as HeaderPair[])),
      ];
      try {
        await stream.write(serializeRequestHead("GET", path, headers));
        const parser = new ResponseParser({ method: "GET" });
        const decoderState = new WsFrameDecoder({ masked: "forbidden" });
        let upgraded: Uint8Array[] | null = null;
        while (upgraded === null) {
          const chunk = await stream.read();
          if (chunk === null) throw new Error("升级没有完成");
          for (const event of parser.feed(chunk)) {
            if (event.type === "head") {
              if (!event.upgrade || event.head.status !== 101)
                throw new Error(`升级被拒（${event.head.status}）`);
              const accept = header(event.head.headers, "sec-websocket-accept");
              if (accept !== (await acceptKey(key)))
                throw new Error("Sec-WebSocket-Accept 不对");
              this.protocol = header(
                event.head.headers,
                "sec-websocket-protocol",
              );
              upgraded = [];
            } else if (event.type === "upgraded") {
              (upgraded ??= []).push(event.bytes);
            }
          }
        }
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit("open", new Event("open"));
        for (const bytes of upgraded) this.frames(decoderState, bytes);
        for (;;) {
          const chunk = await stream.read();
          if (chunk === null) break;
          this.frames(decoderState, chunk);
          if (this.finished) return;
        }
        this.abort(this.closeSent ? 1000 : 1006, "", this.closeSent);
      } catch {
        if (!this.finished) this.abort(1006, "");
      }
    }

    private frames(state: WsFrameDecoder, bytes: Uint8Array): void {
      let events;
      try {
        events = state.feed(bytes);
      } catch {
        this.fail(1002);
        return;
      }
      for (const event of events) {
        if (this.finished) return;
        switch (event.type) {
          case "message": {
            const data = event.binary
              ? this.binaryType === "arraybuffer"
                ? event.data.slice().buffer
                : new Blob([event.data.slice()])
              : decoder.decode(event.data);
            this.emit("message", new MessageEvent("message", { data }));
            break;
          }
          case "ping":
            void this.frame(OPCODE.pong, event.data);
            break;
          case "pong":
            break;
          case "close": {
            const code = event.code ?? 1005;
            if (!this.closeSent) {
              this.closeSent = true;
              void this.frame(
                OPCODE.close,
                event.code === undefined
                  ? new Uint8Array(0)
                  : closePayload(event.code),
              );
            }
            this.readyState = 2;
            void this.writing.then(() => {
              this.stream?.end();
              this.abort(code, event.reason, true);
            });
            return;
          }
        }
      }
    }

    private frame(opcode: number, payload: Uint8Array): Promise<void> {
      const stream = this.stream;
      if (stream === null) return Promise.resolve();
      const bytes = encodeWsFrame({ opcode, payload, mask: randomBytes(4) });
      this.bufferedAmount += payload.length;
      this.writing = this.writing.then(async () => {
        try {
          await stream.write(bytes);
        } catch {
          /* 流关了：下面的读循环会报 1006。 */
        } finally {
          this.bufferedAmount -= payload.length;
        }
      });
      return this.writing;
    }

    send(data: SocketData): void {
      if (this.readyState === 0)
        throw new DOMException("WebSocket is not open", "InvalidStateError");
      if (this.readyState !== 1) return;
      if (typeof data === "string") {
        void this.frame(OPCODE.text, encoder.encode(data));
        return;
      }
      if (data instanceof Blob) {
        // Blob 要异步读；为了保序先占位，读完再写。
        const pending = data.arrayBuffer();
        const stream = this.stream;
        this.writing = this.writing.then(async () => {
          const bytes = new Uint8Array(await pending);
          if (stream === null) return;
          await stream
            .write(
              encodeWsFrame({
                opcode: OPCODE.binary,
                payload: bytes,
                mask: randomBytes(4),
              }),
            )
            .catch(() => undefined);
        });
        return;
      }
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      void this.frame(OPCODE.binary, view);
    }

    close(code?: number, reason?: string): void {
      if (this.readyState >= 2) return;
      if (this.readyState === 0) {
        this.stream?.reset(RST_CODE.clientGone);
        this.abort(code ?? 1000, reason ?? "", true);
        return;
      }
      this.readyState = 2;
      if (!this.closeSent) {
        this.closeSent = true;
        void this.frame(OPCODE.close, closePayload(code ?? 1000, reason ?? ""));
      }
    }

    private fail(code: number): void {
      if (!this.closeSent) {
        this.closeSent = true;
        void this.frame(OPCODE.close, closePayload(code));
      }
      void this.writing.then(() => {
        this.stream?.reset(RST_CODE.protocol);
        this.abort(code, "");
      });
    }

    private abort(code: number, reason: string, wasClean = false): void {
      if (this.finished) return;
      this.finished = true;
      this.readyState = 3;
      if (!wasClean) this.emit("error", new Event("error"));
      this.emit("close", closeEvent(code, reason, wasClean));
      const stream = this.stream;
      if (stream !== null && !stream.closed) stream.reset(RST_CODE.clientGone);
    }
  }

  return ChannelWebSocket as unknown as typeof WebSocket;
}
