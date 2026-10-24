import {
  IdentityRequestError,
  currentAccessToken,
  fetchWsTicket,
} from "../api/identity";
import { resetLocalRuntime } from "../api/local-runtime";
import { installLocalTransport } from "../api/source";
import { type Route, pickRoute } from "./routing";
import { deferredWebSocket } from "./transport";
import {
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceAccess,
  type SourceDescriptor,
  SourceError,
} from "./types";

/**
 * 把一个远程源装成页面的本机源（手机与中继托管的页面共用，客户端包 §4、§5）。
 *
 * 选路（直连优先，D27）→ 取访问 → 把这一路的地址与凭据装给本机源：页面其余
 * 部分（身份面、`api/*`、五条流）不知道自己在直连还是经中继。经中继时每个请求
 * 带 `armadra-relay-token`、每条流多带 `armadra-relay.<令牌>`。访问令牌与中继
 * 令牌到期前、回到前台时提前续；续的时候凭据来源可能经远程服务重取断言。
 *
 * 会话（访问 / 刷新令牌）由身份面持有，从保管处读回（`restore`）：手机是钥匙串，
 * 中继托管的页面是内存。
 *
 * 经端到端通道时（契约 §78）访问里的 `fetch` / `WebSocket` 绑在一条通道上：通道
 * 关了（主机下线、隧道换节点、网络断）这份访问就废了。之后发请求、流（重）连之前
 * 先换一条新通道（单飞；换不上的在 {@link CHANNEL_RETRY_MS} 内不再试，由流自己的
 * 退避去重试），不会在已关的通道上重连。
 */

/**
 * 换一张 WS 票；访问密钥过期（401）时轮转一次再换。长连接在访问密钥到期时被
 * core 以 4401 关掉（契约 §17.4），重连要先换票——不刷新就一直换不到。
 */
export async function ticketWithRefresh(
  fetchTicket: () => Promise<string>,
  refresh: () => Promise<boolean>,
): Promise<string> {
  try {
    return await fetchTicket();
  } catch (error) {
    if (
      !(error instanceof IdentityRequestError && error.status === 401) ||
      !(await refresh())
    )
      throw error;
    return fetchTicket();
  }
}

function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/** 访问令牌（与中继令牌）离到期不到这么久就先换，免得请求在路上过期。 */
export const RENEW_LEAD_MS = 60_000;
export const RENEW_RETRY_MS = 30_000;
/** 通道关了、换新通道没换上：这么久之内别的请求与流不再试（`recover` 不受限）。 */
export const CHANNEL_RETRY_MS = 5_000;

export interface EnterRouteOptions {
  readonly descriptor: SourceDescriptor;
  readonly provider: CredentialProvider;
  /** 选好了路、装传输之前：记下这一路（身份面的保管处键、本机源地址）。 */
  readonly useRoute: (route: Route) => void;
  /** 把保管处里这一路的会话读回身份面；读到答 `true`。 */
  readonly restore: () => Promise<boolean>;
  /** 每次续上（或续不上）之后。 */
  readonly onRenewed?: (access: SourceAccess | null) => void;
  /** 测试用的时钟。 */
  readonly now?: () => number;
}

export interface EnteredRoute {
  readonly route: Route;
  /** 立刻续一次（凭据被拒）；续上答 `true`。 */
  renew(): Promise<boolean>;
  /**
   * 源重新上线、叫醒流之前：端到端通道已经关了就立刻换一条新的（不等冷却）。手里
   * 的通道可用（或这一路没有通道）答 `true`，换不上答 `false`。
   */
  recover(): Promise<boolean>;
  /** 卸掉定时器与可见性监听（传输留着，页面换源靠重载）。 */
  dispose(): void;
}

/**
 * 进一个源。选路失败抛（调用方按 `code` 显示原因）；装好之后由 `restore` 判断
 * 有没有会话。
 */
export async function enterRoute(
  options: EnterRouteOptions,
): Promise<EnteredRoute> {
  const { descriptor, provider } = options;
  const now = options.now ?? Date.now;
  const route = await pickRoute(descriptor, provider);
  const relayed = route.via === "relayed";
  const via = relayed ? "relayed" : "direct";
  options.useRoute(route);
  resetLocalRuntime();

  let access: SourceAccess = route.access;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** 手里这份访问的端到端通道关了：它的 `fetch` / `WebSocket` 不能再用。 */
  let channelDown = false;
  let lastChannelTry = Number.NEGATIVE_INFINITY;
  let unwatch: (() => void) | null = null;
  /** 换手里的访问，并盯着它的通道（参照 `connection.ts` 的 `adopt`）。 */
  const adopt = (next: SourceAccess) => {
    unwatch?.();
    unwatch = null;
    access = next;
    channelDown = false;
    const onClose = next.e2e?.onClose;
    if (onClose === undefined) return;
    unwatch = onClose(() => {
      if (access !== next || disposed) return;
      channelDown = true;
      // 凭据来源缓着的也是这一份：下次取访问要重开通道。
      provider.invalidate(descriptor.sourceId);
    });
  };
  const scheduleRenewal = () => {
    clearTimeout(renewal);
    if (disposed || access.expiresAtMs <= 0) return;
    renewal = setTimeout(
      () => void renewActive(),
      Math.max(access.expiresAtMs - now() - RENEW_LEAD_MS, RENEW_RETRY_MS),
    );
  };
  let renewing: Promise<boolean> | null = null;
  /** 几条并发的 401 只续一次：刷新密钥是一次性的。 */
  const renewActive = (): Promise<boolean> => {
    renewing ??= provider
      .refresh(
        descriptor.sourceId,
        via,
        ...(route.origin === undefined ? [] : [route.origin]),
      )
      .then(async (next) => {
        adopt(next);
        scheduleRenewal();
        const restored = await options.restore();
        options.onRenewed?.(next);
        return restored;
      })
      .catch(() => {
        scheduleRenewal();
        options.onRenewed?.(null);
        return false;
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };
  /**
   * 通道关了就先换一条：并发的只换一次；上一次换不上还在冷却里的直接答 `false`
   * （`force` 不看冷却）。手里的通道可用答 `true`。
   */
  const ensureChannel = async (force = false): Promise<boolean> => {
    if (!channelDown) return true;
    if (renewing === null) {
      if (!force && now() - lastChannelTry < CHANNEL_RETRY_MS) return false;
      lastChannelTry = now();
    }
    await renewActive();
    return !channelDown;
  };
  const stale = () =>
    access.expiresAtMs > 0 && access.expiresAtMs - now() < RENEW_LEAD_MS / 2;
  /** 通道关着、又没换上：请求直接失败，不发到已关的通道上。 */
  const channelClosedFetch: typeof fetch = () =>
    Promise.reject(new TypeError("end-to-end channel closed"));
  const channelSocket = deferredWebSocket(
    () => access.e2e?.WebSocket ?? globalThis.WebSocket,
  );
  adopt(access);
  installLocalTransport({
    origin: originOf(access.httpBase),
    authorization: currentAccessToken,
    prepare: async () => {
      if (channelDown) await ensureChannel();
      // 通道断着（冷却里没换上）就不在这里续：令牌过期了也一样，续期交给
      // `ensureChannel` 与定时器，否则主机长时间离线时每个请求都续一次。
      if (stale() && !channelDown) await renewActive();
    },
    // 流（重）连先换票：通道关着先换一条，换不上就这一次不连（流按退避再来）。
    wsTicket: async () => {
      if (!(await ensureChannel())) throw new SourceError(SOURCE_ERROR.offline);
      return ticketWithRefresh(fetchWsTicket, renewActive);
    },
    refresh: renewActive,
    ...(relayed
      ? {
          // 经端到端通道（契约 §78）：字节走通道，中继令牌只在开通道时用过。
          // 每次现取：通道换了之后用新的那条。流的类在拿到票之后才 `new`，所以
          // 换票时刚换上的通道也赶得上。
          baseFetch: () =>
            channelDown ? channelClosedFetch : access.e2e?.fetch,
          baseWebSocket: () => channelSocket,
          // 经中继时记流量，记到这个源上（`traffic-meter.ts`）。
          meter: {
            sourceId: descriptor.sourceId,
            active: () => true,
            base: () => access.httpBase,
          },
        }
      : {}),
  });
  scheduleRenewal();
  // 回到前台：后台里定时器可能被挂起，令牌已经过期了。
  const onVisible = () => {
    if (globalThis.document?.visibilityState !== "visible") return;
    if (channelDown) void ensureChannel();
    else if (stale()) void renewActive();
  };
  globalThis.document?.addEventListener?.("visibilitychange", onVisible);
  return {
    route,
    renew: renewActive,
    recover: () => ensureChannel(true),
    dispose() {
      disposed = true;
      clearTimeout(renewal);
      unwatch?.();
      unwatch = null;
      globalThis.document?.removeEventListener?.("visibilitychange", onVisible);
    },
  };
}
