/**
 * 测试用的内存 `fetch`：记录每个请求，按 `方法 路径` 找答复，不碰网络。
 * 路径不含查询串；查询串在记录里单独给。
 */

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: Headers;
}

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export type Handler = (request: Recorded) => Reply | undefined;

export function mockFetch(handler: Handler): {
  fetch: typeof globalThis.fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = init?.body;
    const record: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body:
        typeof raw === "string"
          ? JSON.parse(raw)
          : raw instanceof Uint8Array
            ? JSON.parse(Buffer.from(raw).toString("utf8"))
            : undefined,
      headers: new Headers(init?.headers),
    };
    requests.push(record);
    const reply = handler(record) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
