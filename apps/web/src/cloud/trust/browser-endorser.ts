import {
  CloudError,
  browserDevice,
  coreCloudLogin,
  coreCloudProbe,
  coreLogout,
  relayHeaders,
  type CloudAssertion,
} from "../../sources/cloud-client";
import { E2eChannels } from "../../sources/e2e/manager";
import type { BrowserCloudDeps } from "../../sources/credentials";
import type { EndorsableRequest, HostEndorser } from "./endorser";

/**
 * 控制台的生产 `HostEndorser`（云端控制台 §3.3.9）：经已有的端到端通道（契约 §78，
 * `E2eChannels`）与源访问断言（`sources.assertion`）和主机 core 说话，不另造信任通道。
 *
 * - `canEndorse`：`cloud/login` 的只判定模式 `probe`（core 契约 §31.3）。受信答「是」；不受信
 *   答「否」，**不**在主机上建待确认记录、不发事件、不开会话——判定不能惊动主人，也不能留下状态。
 * - `approve`：先确认受信（已有会话就免），再正常登录取会话（设备已受信，不会挂起），同一条通道里
 *   `POST /api/devices/approve { pendingId, sas }`；放行与否由 core 的 `authorizeEndorsement`
 *   判定（契约 §60.4）。校验码只在这个函数的参数与请求体里：错误只带码，不写日志。
 * - 通道按需开：同一个源复用一条；空闲 {@link IDLE_MS} 后注销会话、关掉通道；同时打开与同时进行
 *   的操作都不超过 {@link MAX_OPEN}（超出时关最久没用的）。`dispose()` 立刻放掉全部，
 *   仍在进行的操作在完成时发现代数变了，自己关通道、注销会话并失败，不把结果写回。
 */

/** 一条通道空闲这么久就关（毫秒）。 */
export const IDLE_MS = 60_000;

/** 同时打开的通道上限，也是同时进行的操作数上限。 */
export const MAX_OPEN = 3;

/** 会话离到期不到这么久就当它过期（毫秒）。 */
const RENEW_LEAD_MS = 30_000;

/** 带 `code` 的失败（形状同信任页认得的 `endorseCode`）；不带任何文字细节。 */
function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const unavailable = () => coded("e2e_device_unavailable");

/** core 的错误体 `{ code }` → 码；没有就按状态猜。 */
async function refusalCode(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  const code = body?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code))
    return code;
  if (response.status === 403) return "forbidden";
  if (response.status === 404) return "not_found";
  return "e2e_device_unavailable";
}

export interface BrowserEndorserOptions {
  readonly client: BrowserCloudDeps["client"];
  /** 断言的签发方：控制台所在来源。 */
  readonly issuer: string;
  /** 通道管理；测试注入，缺省按需建一份。 */
  readonly channels?: E2eChannels;
  readonly idleMs?: number;
  readonly maxOpen?: number;
  readonly now?: () => number;
}

export type BrowserEndorser = HostEndorser & { dispose(): void };

/** 一条通道上的一份 core 会话（只在内存里）。 */
interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string | undefined;
  readonly expiresAtMs: number;
  readonly base: string;
  readonly relayToken: string;
  readonly fetch: typeof fetch;
}

interface Slot {
  busy: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  session: Session | undefined;
}

/** 断言 + 已开的通道。 */
interface Opened {
  readonly assertion: CloudAssertion;
  readonly base: string;
  readonly fetch: typeof fetch;
}

export function createBrowserEndorser(
  options: BrowserEndorserOptions,
): BrowserEndorser {
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxOpen = options.maxOpen ?? MAX_OPEN;
  const now = options.now ?? Date.now;
  let channels: E2eChannels | undefined = options.channels;
  const channelsOf = () =>
    (channels ??= new E2eChannels({ deviceName: () => browserDevice().name }));

  /** 每次 `dispose()` 加一：进行中的操作完成时发现变了，就自己收尾并失败。 */
  let generation = 0;
  /** 按最近使用排序（Map 的插入顺序）：最前面最久没用。 */
  const slots = new Map<string, Slot>();
  const waiting: Array<() => void> = [];
  let running = 0;

  const logout = (session: Session): Promise<void> =>
    coreLogout(
      session.base,
      session.refreshToken,
      session.relayToken,
      { fetch: session.fetch },
      session.csrfToken,
    ).catch(() => undefined);

  /** 收尾：注销会话，再关通道（期间同一个源又被用起来了就不关，免得关到新的）。 */
  const close = (sourceId: string, session: Session | undefined) => {
    const done = () => {
      if (!slots.has(sourceId)) channels?.close(options.issuer, sourceId);
    };
    if (session === undefined) done();
    else void logout(session).finally(done);
  };

  const release = (sourceId: string) => {
    const slot = slots.get(sourceId);
    if (slot === undefined || slot.busy > 0) return;
    clearTimeout(slot.timer);
    slots.delete(sourceId);
    close(sourceId, slot.session);
  };

  const enter = (sourceId: string): Slot => {
    let slot = slots.get(sourceId);
    if (slot === undefined) {
      for (const [other, one] of slots) {
        if (slots.size < maxOpen) break;
        if (one.busy === 0) release(other);
      }
      slot = { busy: 0, timer: undefined, session: undefined };
    } else {
      slots.delete(sourceId);
    }
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.busy += 1;
    slots.set(sourceId, slot);
    return slot;
  };

  const leave = (sourceId: string, slot: Slot) => {
    slot.busy -= 1;
    if (slot.busy > 0 || slots.get(sourceId) !== slot) return;
    // 刚用过：挪到最近端，空闲到点就关。
    slots.delete(sourceId);
    slots.set(sourceId, slot);
    slot.timer = setTimeout(() => release(sourceId), idleMs);
  };

  const acquire = (): Promise<void> => {
    if (running < maxOpen) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };

  const free = () => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };

  type Live = () => void;

  async function withSlot<T>(
    sourceId: string,
    run: (live: Live, slot: Slot) => Promise<T>,
  ): Promise<T> {
    await acquire();
    try {
      const mine = generation;
      const live: Live = () => {
        if (mine !== generation) throw unavailable();
      };
      const slot = enter(sourceId);
      try {
        const result = await run(live, slot);
        live();
        return result;
      } finally {
        if (mine === generation) leave(sourceId, slot);
        else {
          // 这期间 dispose 过：本操作留下的会话与通道自己收掉，不写回。
          const session = slot.session;
          slot.session = undefined;
          close(sourceId, session);
        }
      }
    } finally {
      free();
    }
  }

  /** 取断言并开（或复用）这个源的通道。 */
  async function open(sourceId: string, live: Live): Promise<Opened> {
    let assertion: CloudAssertion;
    try {
      assertion = await options.client.sources.assertion({
        sourceId,
        device: browserDevice(),
      });
    } catch {
      throw unavailable();
    }
    live();
    if (!assertion.online) throw unavailable();
    const base = assertion.relayBaseUrl.replace(/\/+$/, "");
    const all = channelsOf();
    let channel: Awaited<ReturnType<E2eChannels["channel"]>>;
    try {
      channel = await all.channel({
        issuer: options.issuer,
        sourceId,
        base,
        relayToken: assertion.relayToken,
      });
    } catch {
      throw unavailable();
    }
    live();
    return { assertion, base, fetch: all.fetchFor(channel, base) };
  }

  async function probe(sourceId: string, live: Live): Promise<boolean> {
    const opened = await open(sourceId, live);
    try {
      return await coreCloudProbe(
        opened.base,
        opened.assertion.relayToken,
        opened.assertion.assertion,
        { fetch: opened.fetch },
      );
    } catch {
      // 限流、离线、通道断了……都不是确定的「否」：不缓存，调用方稍后重试。
      throw unavailable();
    }
  }

  /** 正常登录取会话：只在设备已受信时调（先 probe），所以不会在主机上挂起。 */
  async function login(
    sourceId: string,
    live: Live,
    slot: Slot,
  ): Promise<Session> {
    const opened = await open(sourceId, live);
    let answer: Awaited<ReturnType<typeof coreCloudLogin>>;
    try {
      answer = await coreCloudLogin(
        opened.base,
        opened.assertion.relayToken,
        opened.assertion.assertion,
        undefined,
        { fetch: opened.fetch },
      );
    } catch (error) {
      if (
        error instanceof CloudError &&
        (error.code === "device_pending" || error.code === "device_rejected")
      )
        throw coded("device_untrusted");
      throw unavailable();
    }
    const session: Session = {
      accessToken: answer.native.accessToken,
      refreshToken: answer.native.refreshToken,
      csrfToken: answer.csrfToken,
      expiresAtMs: answer.expiresAtUnixMs,
      base: opened.base,
      relayToken: opened.assertion.relayToken,
      fetch: opened.fetch,
    };
    try {
      live();
    } catch (error) {
      void logout(session);
      throw error;
    }
    slot.session = session;
    return session;
  }

  const fresh = (session: Session) =>
    session.expiresAtMs === 0 || session.expiresAtMs - now() > RENEW_LEAD_MS;

  return {
    canEndorse(sourceId) {
      return withSlot(sourceId, (live) => probe(sourceId, live));
    },

    approve(request: EndorsableRequest, sas: string) {
      if (request.pendingId === "") return Promise.reject(coded("not_found"));
      const { sourceId } = request;
      return withSlot(sourceId, async (live, slot) => {
        const send = async (session: Session) => {
          try {
            return await session.fetch(`${session.base}/api/devices/approve`, {
              method: "POST",
              credentials: "omit",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${session.accessToken}`,
                ...relayHeaders(session.relayToken),
              },
              body: JSON.stringify({ pendingId: request.pendingId, sas }),
            });
          } catch {
            throw unavailable();
          }
        };
        const session = async (renew: boolean): Promise<Session> => {
          if (!renew && slot.session !== undefined && fresh(slot.session))
            return slot.session;
          const stale = slot.session;
          slot.session = undefined;
          if (stale !== undefined) void logout(stale);
          // 没有会话先确认受信：不受信时直接登录会在主机上挂起一条待确认。
          if (!(await probe(sourceId, live))) throw coded("device_untrusted");
          return login(sourceId, live, slot);
        };
        let response = await send(await session(false));
        // 访问令牌被拒（401）：换一份会话再发一次。
        if (response.status === 401) response = await send(await session(true));
        if (!response.ok) throw coded(await refusalCode(response));
      });
    },

    dispose() {
      generation += 1;
      for (const [sourceId, slot] of [...slots]) {
        clearTimeout(slot.timer);
        slots.delete(sourceId);
        const session = slot.session;
        slot.session = undefined;
        close(sourceId, session);
      }
    },
  };
}
