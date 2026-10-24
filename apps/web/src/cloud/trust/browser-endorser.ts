import { createBrowserCloudCredentialProvider } from "../../sources/credentials";
import { browserDevice } from "../../sources/cloud-client";
import { E2eAccessError, E2eChannels } from "../../sources/e2e/manager";
import { RELAY_TOKEN_HEADER } from "../../sources/transport";
import { SOURCE_ERROR, type SourceAccess } from "../../sources/types";
import type { BrowserCloudDeps } from "../../sources/credentials";
import type { EndorsableRequest, HostEndorser } from "./endorser";

/**
 * 控制台的生产 `HostEndorser`（云端控制台 §3.3.9）：用 `browser-cloud` 凭据提供方经已有的
 * 端到端通道（契约 §78）登录主机，不另造信任通道。
 *
 * - `canEndorse`：登录成功 = 本浏览器是这台主机上这位成员的受信设备；主机答 `device_pending`
 *   （新设备、未信任）就是不能。判定时**不**等主人核对，也不弹待确认对话框（见 {@link probing}）。
 * - `approve`：同一条通道里 `POST /api/devices/approve { pendingId, sas }`，条件由 core 的
 *   `authorizeEndorsement` 判定（契约 §60.4）。校验码只在这个函数的参数与请求体里：不进
 *   错误对象（错误只带码）、不写日志、不放进任何缓存键。
 * - 通道按需开：同一个源复用一条；空闲 {@link IDLE_MS} 后关掉并忘掉访问；同时打开不超过
 *   {@link MAX_OPEN} 条（超出时关最久没用的）。
 */

/** 一条通道空闲这么久就关（毫秒）。 */
export const IDLE_MS = 60_000;

/** 同时打开的通道上限，也是同时进行的操作数上限。 */
export const MAX_OPEN = 3;

/** 带 `code` 的失败（形状同信任页认得的 `endorseCode`）；不带任何文字细节。 */
function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * 给提供方用的通道面：登录遇到 `device_pending` 时不等主人——背书人自己的设备都还没受信，
 * 等也没人核对。直接取消（提供方记成「未授权」），也就不会弹出待确认对话框。
 */
function probing(channels: E2eChannels): E2eChannels {
  const face = {
    channel: (target) => channels.channel(target),
    fetchFor: (channel, base) => channels.fetchFor(channel, base),
    socketFor: (channel, base) => channels.socketFor(channel, base),
    awaitApproval: () => Promise.reject(new E2eAccessError("cancelled")),
  } satisfies Pick<
    E2eChannels,
    "channel" | "fetchFor" | "socketFor" | "awaitApproval"
  >;
  return face as unknown as E2eChannels;
}

/** 登录路上的失败 → 信任页认得的码。 */
function accessFailure(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === SOURCE_ERROR.unauthorized ||
    code === SOURCE_ERROR.deviceRejected ||
    code === SOURCE_ERROR.accessRevoked ||
    code === SOURCE_ERROR.revoked
  )
    return coded("device_untrusted");
  return coded("e2e_device_unavailable");
}

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
}

export type BrowserEndorser = HostEndorser & { dispose(): void };

interface Slot {
  busy: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createBrowserEndorser(
  options: BrowserEndorserOptions,
): BrowserEndorser {
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxOpen = options.maxOpen ?? MAX_OPEN;
  let channels: E2eChannels | undefined = options.channels;
  let provider: ReturnType<typeof createBrowserCloudCredentialProvider> | null =
    null;
  const ensure = () => {
    channels ??= new E2eChannels({ deviceName: () => browserDevice().name });
    provider ??= createBrowserCloudCredentialProvider({
      client: options.client,
      issuer: options.issuer,
      e2e: probing(channels),
    });
    return { channels, provider };
  };

  /** 按最近使用排序（Map 的插入顺序）：最前面最久没用。 */
  const slots = new Map<string, Slot>();
  const waiting: Array<() => void> = [];
  let running = 0;

  const release = (sourceId: string) => {
    const slot = slots.get(sourceId);
    if (slot === undefined || slot.busy > 0) return;
    clearTimeout(slot.timer);
    slots.delete(sourceId);
    channels?.close(options.issuer, sourceId);
    provider?.invalidate(sourceId);
  };

  const enter = (sourceId: string) => {
    let slot = slots.get(sourceId);
    if (slot === undefined) {
      for (const [other, one] of slots) {
        if (slots.size < maxOpen) break;
        if (one.busy === 0) release(other);
      }
      slot = { busy: 0, timer: undefined };
    } else {
      slots.delete(sourceId);
    }
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.busy += 1;
    slots.set(sourceId, slot);
  };

  const leave = (sourceId: string) => {
    const slot = slots.get(sourceId);
    if (slot === undefined) return;
    slot.busy -= 1;
    if (slot.busy > 0) return;
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

  async function withSlot<T>(
    sourceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    await acquire();
    try {
      enter(sourceId);
      try {
        return await run();
      } finally {
        leave(sourceId);
      }
    } finally {
      free();
    }
  }

  const access = (sourceId: string, renew: boolean): Promise<SourceAccess> => {
    const { provider } = ensure();
    return (
      renew
        ? provider.refresh(sourceId, "relayed")
        : provider.getAccess(sourceId, "relayed")
    ).catch((error: unknown) => {
      throw accessFailure(error);
    });
  };

  return {
    canEndorse(sourceId) {
      return withSlot(sourceId, async () => {
        try {
          await access(sourceId, false);
          return true;
        } catch (error) {
          // 主机说这台浏览器不是受信设备：这是确定的答案；其余（离线、通道失败）让调用方重试。
          if ((error as { code?: unknown }).code === "device_untrusted")
            return false;
          throw error;
        }
      });
    },

    approve(request: EndorsableRequest, sas: string) {
      if (request.pendingId === "") return Promise.reject(coded("not_found"));
      return withSlot(request.sourceId, async () => {
        const send = async (granted: SourceAccess) => {
          const fetcher = granted.e2e?.fetch;
          if (fetcher === undefined) throw coded("e2e_device_unavailable");
          try {
            return await fetcher(`${granted.httpBase}/api/devices/approve`, {
              method: "POST",
              credentials: "omit",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${granted.accessToken}`,
                ...(granted.relayToken === undefined
                  ? {}
                  : { [RELAY_TOKEN_HEADER]: granted.relayToken }),
              },
              body: JSON.stringify({ pendingId: request.pendingId, sas }),
            });
          } catch {
            throw coded("e2e_device_unavailable");
          }
        };
        let response = await send(await access(request.sourceId, false));
        // 访问令牌过期（401）：换一份再发一次。
        if (response.status === 401)
          response = await send(await access(request.sourceId, true));
        if (!response.ok) throw coded(await refusalCode(response));
      });
    },

    dispose() {
      for (const [sourceId, slot] of [...slots]) {
        slot.busy = 0;
        release(sourceId);
      }
      provider?.clear();
    },
  };
}
