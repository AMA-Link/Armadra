// 探针里的端到端通道客户端（契约 §78）。
//
// 经中继的字节只走 `<源基址>/_relay/e2e` 这一条通道（Armadra E5、armadra-cloud#50）：
// 带 `Armadra-Relay-Token` 的明文请求中继一律答 404。这里复用页面那一份客户端
// （`@armadra/shared/e2e`：通道、`fetch`、`WebSocket`），只补 Node 一侧的三样东西：
//   * 底层 WebSocket 用 `ws`，个人中转自签证书时钉 CA；
//   * 新设备由主人在 core 上核对校验码放行（`approve` 回调，默认探针直接调
//     `/api/devices/approve`）；
//   * `ws` 形状的 `socket()` 与按路径取 JSON / 原始响应的小工具，给原来对明文中继写的探针用。
//
// 需要先 `pnpm libs:build`（`packages/shared/dist`）。
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "./ui-features/harness.mjs";

const sharedDir = join(root, "packages/shared");
let loaded;
async function modules() {
  loaded ??= (async () => {
    const shared = await import(
      pathToFileURL(join(sharedDir, "dist/e2e/index.js")).href
    );
    const protocol = await import(
      pathToFileURL(
        join(
          sharedDir,
          "node_modules/@armadra/platform-protocol/dist/e2e/index.js",
        ),
      ).href
    );
    const Ws = createRequire(join(root, "apps/desktop/package.json"))("ws");
    return { shared, protocol, Ws };
  })();
  return loaded;
}

/** 原 `ws` 的子类，构造器是浏览器的形状，另带钉扎的 CA。 */
function pinnedSocket(Ws, ca) {
  return class PinnedSocket extends Ws {
    constructor(url, protocols) {
      super(url, protocols, {
        perMessageDeflate: false,
        servername: "",
        maxPayload: 64 * 1024 * 1024,
        ...(ca ? { ca } : {}),
      });
    }
  };
}

/** 探针直接对主人的 core 说话时放行一台新设备：页面上的校验码对上才放行。 */
export function approveWith(session) {
  return async (pendingId, sas) => {
    const answer = await session.fetch("/api/devices/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingId, sas }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `devices/approve → ${answer.status} ${text.slice(0, 200)}`,
      );
  };
}

/**
 * 开一条通道、换 core 会话，答一个路由对象：
 * `{ channel, fetch, json(method, path, body?), raw(method, path, headers?), protocols(),
 *    socket(path, protocols?), close() }`。路径都是源内路径（`/api/...`）。
 *
 * - `url`：源基址（`https://<中继>/s/<id>`，或 saas 的子域），通道在 `<url>/_relay/e2e`。
 * - `assertion`：`/v1/sources/<id>/assertion` 签的断言；`approve(pendingId, sas)` 放行新设备。
 * - `invitationToken`：访客链接的邀请令牌，既是通道 m3 的 proof（契约 §80），也随 `cloud/login` 带上。
 * - `seed`：设备钥种子（32 字节）；同一个种子再开就是同一台设备，不再需要放行。
 */
export async function openE2eRoute({
  url,
  caPem,
  sourceId,
  relayToken,
  assertion,
  approve,
  seed = randomBytes(32),
  name = "probe",
  origin = "https://localhost",
  invitationToken,
  proofSecret = invitationToken === undefined
    ? undefined
    : new TextEncoder().encode(invitationToken),
  pinned,
}) {
  const { shared, protocol, Ws } = await modules();
  const base = url.replace(/\/+$/, "");
  const channel = await shared.E2eClientChannel.open({
    url: `${base.replace(/^http/, "ws")}/_relay/e2e`,
    relayToken,
    sourceId,
    device: await protocol.ed25519SignerFromSeed(new Uint8Array(seed)),
    platform: "desktop",
    name,
    WebSocket: pinnedSocket(Ws, caPem),
    ...(proofSecret ? { proofSecret } : {}),
    ...(pinned ? { pinned } : {}),
  });
  const doFetch = shared.channelFetch(channel, { origin, base });
  const ChannelSocket = shared.channelWebSocket(channel, { origin, base });
  let accessToken = null;
  const headersOf = (extra = {}) => ({
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...extra,
  });
  const login = async () => {
    const attempt = () =>
      doFetch(`${base}/api/identity/cloud/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assertion,
          ...(invitationToken === undefined ? {} : { invitationToken }),
        }),
      });
    let answer = await attempt();
    if (answer.status === 403) {
      const body = await answer.json();
      const pendingId = body?.details?.pendingId;
      if (!pendingId || !approve)
        throw new Error(`cloud/login 被拒：${JSON.stringify(body)}`);
      await approve(pendingId, channel.sas);
      answer = await attempt();
    }
    const text = await answer.text();
    if (answer.status !== 200)
      throw new Error(`cloud/login → ${answer.status} ${text.slice(0, 200)}`);
    accessToken = JSON.parse(text).session.native.accessToken;
    return accessToken;
  };
  const raw = async (method, path, extra = {}, body) => {
    const answer = await doFetch(`${base}${path}`, {
      method,
      headers: headersOf(extra),
      ...(body === undefined ? {} : { body }),
    });
    const bytes = Buffer.from(await answer.arrayBuffer());
    const headers = {};
    answer.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: answer.status, headers, body: bytes };
  };
  const json = async (method, path, body) => {
    const answer = await raw(
      method,
      path,
      body === undefined ? {} : { "content-type": "application/json" },
      body === undefined ? undefined : JSON.stringify(body),
    );
    const text = answer.body.toString("utf8");
    if (answer.status >= 400)
      throw new Error(
        `${method} ${path} → ${answer.status} ${text.slice(0, 200)}`,
      );
    return text ? JSON.parse(text) : null;
  };
  const protocols = async () => {
    const { ticket } = await json("POST", "/api/identity/ws-ticket", {});
    return [`armadra-ticket.${ticket}`];
  };
  /** `ws` 库形状的 WebSocket（`on` / `once` / `send` / `close`），消息是文本时给字符串。 */
  const socket = (path, list = []) => {
    const inner = new ChannelSocket(`${base}${path}`, list);
    inner.binaryType = "arraybuffer";
    const listeners = new Map();
    const emit = (event, ...args) => {
      for (const one of [...(listeners.get(event) ?? [])]) one(...args);
    };
    inner.addEventListener("open", () => emit("open"));
    inner.addEventListener("error", () =>
      emit("error", new Error("socket error")),
    );
    inner.addEventListener("close", (event) =>
      emit("close", event.code, Buffer.from(event.reason ?? "")),
    );
    inner.addEventListener("message", (event) =>
      emit(
        "message",
        typeof event.data === "string" ? event.data : Buffer.from(event.data),
        typeof event.data !== "string",
      ),
    );
    const on = (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return facade;
    };
    const facade = {
      on,
      addListener: on,
      once(event, listener) {
        const wrapped = (...args) => {
          facade.off(event, wrapped);
          listener(...args);
        };
        return on(event, wrapped);
      },
      off(event, listener) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((one) => one !== listener),
        );
        return facade;
      },
      removeListener(event, listener) {
        return facade.off(event, listener);
      },
      send: (data) => inner.send(data),
      close: (code, reason) => inner.close(code, reason),
      terminate: () => inner.close(),
      get readyState() {
        return inner.readyState;
      },
      get protocol() {
        return inner.protocol;
      },
      OPEN: 1,
    };
    return facade;
  };
  return {
    channel,
    fetch: doFetch,
    base,
    login,
    json,
    raw,
    protocols,
    socket,
    get accessToken() {
      return accessToken;
    },
    close: () => channel.close(),
  };
}
