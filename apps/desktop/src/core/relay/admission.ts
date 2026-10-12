/**
 * 隧道来的请求的准入（契约 §32，平台规格 core 包 §4.4）：与 Gateway 的 Bearer 模式
 * 等价，不享受回环的匿名，也不认 Cookie。挂在 `CoreServer.createListener({
 * admitted: true, gate })` 上，在路由与流之前判：
 *
 *   1. 路径落在 `loopbackOnlyPath`（`/hook/`、`/control/`、`/context-link/`、
 *      `/browser/`、`/verify`）→ `403 forbidden`。
 *   2. 来源以 `OPEN.clientOrigin` 为准（中继给的元数据），请求头里的 `Origin` 与它
 *      不一致 → 403。来源必须在这条登记的可信来源 ∪ 原生 App 的两个来源之内；
 *      没有来源（非浏览器）只放行 `/health` 与身份域自己的匿名面。例外：中继
 *      托管的页面（来源就是中继自己）发的同源 GET 浏览器不带 `Origin`，这时认
 *      `Sec-Fetch-Site: same-origin`（脚本改不了的头），来源取会话来源；升级
 *      浏览器总带 `Origin`，不走这条。
 *   3. 匿名面放行（以一个没有任何授权的成员身份跑）；`POST /api/identity/ws-ticket`
 *      由这里签票；其余要 `Authorization: Bearer`，升级要 `armadra-ticket.<票>`。
 *      拒绝一律 `401 unauthenticated`。
 *
 * 放行时把认出的主体交给这条流的流量计数器（契约 §76）：匿名面记成匿名，拒绝的
 * 不认，流结束时按匿名记。
 * 端到端通道（契约 §77、§78）：内层流带着通道对端的设备钥，不看来源（第 2 条只对
 * 明文路径）。经通道签的会话绑那把
 * 钥（`identity_sessions.channel_device_id`），通道设备与会话设备不符、或那把钥对
 * 这个人已不再信任 → 401；不经通道签的会话进不了通道，经通道签的也进不了明文路径。
 * 主人开了 `security.requireE2e` 时明文路径一律 `403 e2e_required`。
 *
 * 会话绑在这个远程服务的中继来源上（`relayOrigins[0]`，缺省就是 issuer）：经隧道
 * 换来的会话只在隧道上有效，回环与 Gateway 的会话也进不了隧道。放行前把请求头的
 * `Origin` 换成它，并标成 Bearer 传输（`markBearerTransport`），身份域据此按原生
 * 会话答、不发 Cookie。CORS 只回客户端自己的来源。
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  bearerToken,
  loopbackOnlyPath,
  nativeAppOrigin,
} from "../gateway/admission";
import type { RequestIdentity } from "../identity/gate";
import { markBearerTransport } from "../identity/http";
import { canonicalOrigin } from "../identity/origin";
import type { IdentityService } from "../identity/service";
import {
  E2E_IDENTITY_PATH,
  WS_TICKET_PATH,
  type WsTickets,
  anonymousPath,
  pairingCodePath,
  mediaPath,
  protocolTicket,
  sessionIdentity,
} from "../identity/transport";
import { coreError } from "../http/errors";
import type { CoreRequest } from "../http/router";
import type { ListenerGate, ListenerVerdict } from "../http/server";
import { e2eDevices } from "./e2e/peer";
import { TunnelDuplex } from "./streams";

export interface TunnelRegistration {
  readonly issuer: string;
  readonly trustedOrigins: readonly string[];
  readonly relayOrigins: readonly string[];
}

export interface TunnelGateOptions {
  readonly service: IdentityService;
  /** 有效登记；撤销了就是 `undefined`（这条隧道上的请求一律 403）。 */
  readonly registration: (issuer: string) => TunnelRegistration | undefined;
  readonly tickets: WsTickets;
  /** 设置 `security.requireE2e`：开着时明文路径一律 403。缺省关。 */
  readonly requireE2e?: () => boolean;
  /** 设备钥这个人还信不信（撤销后立刻失效）；缺省按设备登记。 */
  readonly deviceTrusted?: (deviceId: string, principalId: string) => boolean;
}

/**
 * 匿名面上的请求身份：一个什么授权都没有的成员（与 Gateway 同一个做法）。不留空——
 * 留空 core 会当成本机 owner。
 */
const ANONYMOUS: RequestIdentity = {
  subject: { principalId: "", kind: "member", scopes: [] },
};

const FORBIDDEN_BODY = { code: "forbidden", message: "来源不被允许" };
const UNAUTHENTICATED_BODY = {
  code: "unauthenticated",
  message: "需要一个经远程服务登录的会话",
};
const E2E_REQUIRED_BODY = coreError(
  403,
  "e2e_required",
  "这台电脑只接受端到端加密的连接",
).body;

/** 会话绑定的来源：这条登记的第一个中继来源，缺省 issuer。 */
export function sessionOriginOf(registration: TunnelRegistration): string {
  for (const origin of registration.relayOrigins) {
    const canonical = canonicalOrigin(origin);
    if (canonical !== undefined) return canonical;
  }
  return registration.issuer;
}

function corsFor(clientOrigin: string | null): Record<string, string> {
  if (clientOrigin === null) return {};
  return {
    "access-control-allow-origin": clientOrigin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, x-armadra-csrf",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function originAllowed(
  clientOrigin: string,
  registration: TunnelRegistration,
): boolean {
  if (nativeAppOrigin(clientOrigin)) return true;
  const canonical = canonicalOrigin(clientOrigin);
  if (canonical === undefined) return false;
  return registration.trustedOrigins.some(
    (trusted) => canonicalOrigin(trusted) === canonical,
  );
}

/** 请求头里的 `Origin` 与 `OPEN.clientOrigin` 一致（都没有也算一致）。 */
function sameDeclaredOrigin(
  headers: IncomingHttpHeaders,
  clientOrigin: string | null,
): boolean {
  const declared = headers.origin;
  if (Array.isArray(declared)) return false;
  if (declared === undefined) return clientOrigin === null;
  return declared === clientOrigin;
}

/**
 * 浏览器在页面自己的来源上发的请求（同源 GET / HEAD 不带 `Origin`）。
 * `Sec-Fetch-*` 是禁改头：页面脚本伪造不了；非浏览器客户端伪造它也只是把自己
 * 绑到会话来源上，照样要那个来源签的 Bearer。
 */
function sameOriginBrowserRequest(headers: IncomingHttpHeaders): boolean {
  return headers["sec-fetch-site"] === "same-origin";
}

/** 没有来源的客户端（非浏览器）只能碰这几条。 */
function anonymousWithoutOrigin(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/health" ||
    // 媒体票（契约 §37.4）：`<video src>` 不带 `Origin`，票就是凭据。
    mediaPath(path) ||
    path === E2E_IDENTITY_PATH ||
    (path.startsWith("/api/identity/") &&
      anonymousPath(path) &&
      path !== WS_TICKET_PATH)
  );
}

export function createTunnelGate(options: TunnelGateOptions): ListenerGate {
  const decide = tunnelVerdict(options);
  return (request: CoreRequest, upgrade: boolean): ListenerVerdict => {
    const verdict = decide(request, upgrade);
    const socket = request.raw.socket as unknown;
    if (
      socket instanceof TunnelDuplex &&
      socket.counter !== undefined &&
      "identity" in verdict
    ) {
      const identity = verdict.identity;
      socket.counter.identify(
        identity === undefined || identity.subject.principalId === ""
          ? undefined
          : {
              principalId: identity.subject.principalId,
              deviceId: identity.device?.deviceId ?? "",
            },
      );
    }
    return verdict;
  };
}

function tunnelVerdict(
  options: TunnelGateOptions,
): (request: CoreRequest, upgrade: boolean) => ListenerVerdict {
  const { service, tickets } = options;
  return (request: CoreRequest, upgrade: boolean): ListenerVerdict => {
    const socket = request.raw.socket as unknown;
    const tunnel = socket instanceof TunnelDuplex ? socket.tunnel : undefined;
    const registration =
      tunnel === undefined ? undefined : options.registration(tunnel.issuer);
    if (tunnel === undefined || registration === undefined) {
      return { refusal: { status: 403, body: FORBIDDEN_BODY } };
    }
    const clientOrigin = tunnel.open.clientOrigin;
    const cors = corsFor(clientOrigin);
    const refuse = (status: number, body: typeof FORBIDDEN_BODY) => ({
      refusal: { status, body, cors },
    });
    const path = request.path;
    if (loopbackOnlyPath(path)) {
      return refuse(403, { code: "forbidden", message: "这条路径只在本机" });
    }
    // 8 位配对码只给局域网直连（契约 §24、§73）：中继在公网上，经它进来的
    // 换票与 PAKE 一律不放行，首连走扫码。
    if (pairingCodePath(path)) {
      return refuse(403, {
        code: "pairing_code_disabled",
        message: "经中继不能用配对码，请在局域网直连或扫码",
      });
    }
    const channel = tunnel.channel;
    if (channel === undefined && (options.requireE2e?.() ?? false)) {
      return refuse(403, E2E_REQUIRED_BODY);
    }
    // 来源检查只对明文路径：端到端通道里的请求是持有设备钥的那段代码自己编的，
    // 跨站页面碰不到这条通道，来源说明不了任何事（原生客户端也不一定带它）。
    if (channel === undefined) {
      if (!sameDeclaredOrigin(request.headers, clientOrigin)) {
        return refuse(403, FORBIDDEN_BODY);
      }
      if (clientOrigin !== null && !originAllowed(clientOrigin, registration)) {
        return { refusal: { status: 403, body: FORBIDDEN_BODY } };
      }
      if (
        clientOrigin === null &&
        (upgrade ||
          (!anonymousWithoutOrigin(path) &&
            !sameOriginBrowserRequest(request.headers)))
      ) {
        return refuse(403, FORBIDDEN_BODY);
      }
    }

    // 下游（身份域、CORS、流）看到的来源是会话来源；凭据按 Bearer 模式。
    const origin = sessionOriginOf(registration);
    request.headers.origin = origin;
    markBearerTransport(request.raw);
    const hostId = service.hostId();
    const deviceTrusted =
      options.deviceTrusted ??
      ((deviceId: string, principalId: string) =>
        e2eDevices()?.trusted(deviceId, principalId) ?? false);
    const authenticated = (accessToken: string) => {
      try {
        const principal = service.authenticate({ accessToken, hostId, origin });
        // 会话与通道得是同一把设备钥：明文签的进不了通道，通道签的进不了明文
        // 路径，也进不了别的设备的通道（契约 §77）。
        const bound = principal.channelDeviceId ?? "";
        if (bound !== (channel?.deviceId ?? "")) return undefined;
        if (
          channel !== undefined &&
          !deviceTrusted(bound, principal.principalId)
        )
          return undefined;
        return { principal, accessToken };
      } catch {
        return undefined;
      }
    };

    if (upgrade) {
      const ticket = protocolTicket(request.headers);
      const redeemed = ticket === "" ? undefined : tickets.consume(ticket);
      if (redeemed === undefined || redeemed.origin !== origin) {
        return refuse(401, UNAUTHENTICATED_BODY);
      }
      const who = authenticated(redeemed.accessToken);
      if (who === undefined) return refuse(401, UNAUTHENTICATED_BODY);
      return {
        cors,
        identity: sessionIdentity(service, hostId, who.principal, origin),
      };
    }
    // 预检不带凭据（浏览器规定），只回 CORS。
    if (request.method === "OPTIONS") return { cors, identity: ANONYMOUS };
    if (path === WS_TICKET_PATH) {
      if (request.method !== "POST") {
        return refuse(405, {
          code: "method_not_allowed",
          message: "只接受 POST",
        });
      }
      const token = bearerToken(request.headers);
      const who = token === "" ? undefined : authenticated(token);
      if (who === undefined) return refuse(401, UNAUTHENTICATED_BODY);
      const issued = tickets.issue({ accessToken: who.accessToken, origin });
      return {
        reply: {
          status: 200,
          body: {
            ticket: issued.ticket,
            expiresAt: new Date(issued.expiresAtMs).toISOString(),
          },
          cors: { ...cors, "cache-control": "no-store" },
        },
      };
    }
    const api = path === "/api" || path.startsWith("/api/");
    if (!api || anonymousPath(path)) return { cors, identity: ANONYMOUS };
    const token = bearerToken(request.headers);
    const who = token === "" ? undefined : authenticated(token);
    if (who === undefined) return refuse(401, UNAUTHENTICATED_BODY);
    return {
      cors,
      identity: sessionIdentity(service, hostId, who.principal, origin),
    };
  };
}
