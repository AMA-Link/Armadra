import { describe, expect, it, vi } from "vitest";

import { cookieFetch } from "./transport";

const ORIGIN = "https://armadra.lan:8443";
const OLD = "a".repeat(43);
const NEW = "b".repeat(43);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 第一次答 `first`，之后都答 200；记下每次发出的头与体。 */
function server(first: Response) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return sent.length === 1 ? first : json(200, { ok: true });
  });
  return { base: base as unknown as typeof fetch, sent };
}

function transport(refreshed = true) {
  let csrf = OLD;
  const refresh = vi.fn(async () => {
    if (refreshed) csrf = NEW;
    return refreshed;
  });
  return { origin: ORIGIN, refresh, csrf: () => csrf };
}

describe("cookieFetch（契约 §3.2，访问 Cookie 过期后透明续期）", () => {
  it("会话失效的 401：续一次再重放，调用方只看到重放的答复", async () => {
    const { base, sent } = server(json(401, { code: "unauthenticated" }));
    const session = transport();
    const response = await cookieFetch(base, session)(`${ORIGIN}/api/settings`);
    expect(response.status).toBe(200);
    expect(session.refresh).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it("重放的写请求换上续期后的 CSRF，体原样再发", async () => {
    const { base, sent } = server(json(401, { code: "unauthenticated" }));
    const response = await cookieFetch(base, transport())(
      `${ORIGIN}/api/rpc/settings/patch`,
      {
        method: "POST",
        headers: { "X-Armadra-CSRF": OLD, "content-type": "application/json" },
        body: '{"a":1}',
      },
    );
    expect(response.status).toBe(200);
    const replay = new Headers(sent[1]?.init?.headers);
    expect(replay.get("x-armadra-csrf")).toBe(NEW);
    expect(replay.get("content-type")).toBe("application/json");
    expect(sent[1]?.init?.body).toBe('{"a":1}');
    expect(sent[1]?.init?.method).toBe("POST");
  });

  it("没带 CSRF 的读请求重放时也不凭空加上", async () => {
    const { base, sent } = server(json(401, {}));
    await cookieFetch(base, transport())(`${ORIGIN}/api/workspaces`);
    expect(new Headers(sent[1]?.init?.headers).has("x-armadra-csrf")).toBe(
      false,
    );
  });

  it("续不上：原来那次 401 原样交出，不重放", async () => {
    const first = json(401, { code: "unauthenticated" });
    const { base, sent } = server(first);
    const response = await cookieFetch(
      base,
      transport(false),
    )(`${ORIGIN}/api/settings`);
    expect(response).toBe(first);
    expect(sent).toHaveLength(1);
  });

  it("具名的 401、身份面、别的来源、流式请求体都不续", async () => {
    const cases: [string, RequestInit | undefined, Response][] = [
      [
        `${ORIGIN}/api/rpc/identity/mfa`,
        { method: "POST", body: "{}" },
        json(401, { code: "mfa_invalid_code" }),
      ],
      [
        `${ORIGIN}/api/identity/session`,
        undefined,
        json(401, { code: "unauthenticated" }),
      ],
      [
        "https://elsewhere.example/api/settings",
        undefined,
        json(401, { code: "unauthenticated" }),
      ],
      [
        `${ORIGIN}/api/files/upload`,
        {
          method: "POST",
          body: new ReadableStream(),
          duplex: "half",
        } as RequestInit,
        json(401, { code: "unauthenticated" }),
      ],
    ];
    for (const [url, init, first] of cases) {
      const { base, sent } = server(first);
      const session = transport();
      const response = await cookieFetch(base, session)(url, init);
      expect(response.status).toBe(401);
      expect(session.refresh).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
    }
  });

  it("不是 401 的答复原样放过", async () => {
    const { base } = server(json(403, { code: "forbidden" }));
    const session = transport();
    const response = await cookieFetch(base, session)(`${ORIGIN}/api/x`);
    expect(response.status).toBe(403);
    expect(session.refresh).not.toHaveBeenCalled();
  });

  it("FormData 体可以重放", async () => {
    const { base, sent } = server(json(401, { code: "unauthenticated" }));
    const form = new FormData();
    form.set("file", new Blob(["x"]), "x.txt");
    await cookieFetch(base, transport())(`${ORIGIN}/api/upload`, {
      method: "POST",
      body: form,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.init?.body).toBe(form);
  });
});
