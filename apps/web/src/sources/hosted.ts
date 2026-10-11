import {
  type HostedSessionStore,
  restoreHostedCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import {
  type CloudOptions,
  type CloudSource,
  CloudError,
  browserDevice,
  cloudLogin,
  cloudAcceptLink,
  cloudLinkInfo,
  cloudLogout,
  cloudPlatformInfo,
  coreCloudLogin,
  cloudSources,
} from "./cloud-client";
import { createCachedCredentialProvider } from "./credentials";
import type { ManagedSocketState } from "./managed-socket";
import { type SiblingMount, mountSiblingSources } from "./mounts";
import { sourceRegistry } from "./registry";
import {
  type RelaySession,
  type RelayVault,
  createCloudSessions,
  createRelayedAccess,
} from "./relay-access";
import {
  type RemoteStream,
  type StreamTarget,
  applyMeStreamEvent,
  createRemoteStream,
  resyncTargets,
} from "./remote-stream";
import { type EnteredRoute, enterRoute } from "./route-entry";
import {
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceDescriptor,
  SourceError,
  type SourceFailure,
  type SourceState,
} from "./types";

/**
 * 中继托管的页面（客户端包 §5，平台设计 §17.3）：个人中转在 `/app/` 托管的就是
 * 这份 `apps/web`。页面背后没有本机 core：用中继账号口令登录远程服务，挑一台
 * 主机，把它经中继装成页面的本机源（`route-entry.ts`，与手机同一份）。
 *
 * - 访问令牌只在内存。两把刷新令牌（远程服务的、源 core 的）与上次进的主机
 *   另记一份在 `sessionStorage`（{@link createSessionRelayVault}）：只这个标签页、
 *   只中继这个来源能读，关标签即丢；刷新页面时用它们静默续上（{@link
 *   HostedRelay.resume}），登出、被拒时清掉。
 * - 按分享链接加入的访客例外：刷新令牌按 签发方 + 链接 记在 `localStorage`
 *   （{@link createSessionRelayVault} 的 `key`），寿命 = 链接到期；到期、被收回
 *   （401、`accessRevoked`）即清。刷新后 {@link HostedRelay.resume} 先试它，再回账号登录。
 * - 所有请求同源（中继的 `/v1/*`、`/s/<源>/…`）：中继给页面的 CSP 是
 *   `connect-src 'self'`，core 认中继来源为可信来源（契约 §32）。
 * - `me.stream`：主机下线 → 等它上线（`waitingForSource`），上线 → 叫醒事件流；
 *   主机被撤销、访问被收回 → `unauthorized`，界面提示重新登录。
 */

/** 页面路径在中继托管的那一段下（`/app/…`）。只有这时才去问平台信息。 */
export function underRelayAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

export interface RelayHost {
  /** 远程服务的签发方，也就是页面自己的来源。 */
  readonly issuer: string;
}

/**
 * 这张页面是不是个人中转托管的：路径在 `/app/` 下，同源的
 * `/.well-known/armadra-platform` 答 `personal`，签发方就是页面来源。不是就
 * `null`（桌面窗口、服务器壳、开发服务器都不在 `/app/` 下，一个请求也不发）。
 */
export async function detectRelayHost(
  location:
    | Pick<Location, "origin" | "pathname">
    | undefined = globalThis.location,
  options: CloudOptions = {},
): Promise<RelayHost | null> {
  if (location === undefined || !underRelayAppPath(location.pathname))
    return null;
  const info = await cloudPlatformInfo(location.origin, {
    timeoutMs: 5_000,
    ...options,
  }).catch(() => null);
  if (info === null || info.mode !== "personal") return null;
  let issuer: string;
  try {
    issuer = new URL(info.issuer).origin;
  } catch {
    return null;
  }
  return issuer === location.origin ? { issuer } : null;
}

/* --------------------------------- 保管处 --------------------------------- */

export interface MemoryRelayVault extends RelayVault {
  clear(): void;
}

/** 只在内存里的保管处：一个签发方一把刷新令牌，一个源一份会话。 */
export function createMemoryRelayVault(): MemoryRelayVault {
  const remotes = new Map<string, string>();
  const sessions = new Map<string, RelaySession>();
  return {
    cloudRefreshToken: async (issuer) => remotes.get(issuer) ?? null,
    async saveCloudRefreshToken(issuer, refreshToken) {
      remotes.set(issuer, refreshToken);
    },
    async forgetCloud(issuer) {
      remotes.delete(issuer);
    },
    session: async (sourceId) => sessions.get(sourceId),
    async saveSession(sourceId, _issuer, session) {
      sessions.set(sourceId, session);
    },
    clear() {
      remotes.clear();
      sessions.clear();
    },
  };
}

/* ------------------------------ 刷新后续上 ------------------------------- */

/**
 * 刷新页面要续上的那点东西：两把刷新令牌与上次进的主机。访问令牌不落盘——
 * 续的时候用刷新令牌换新的（都会旋转，旧的随即作废）。
 *
 * 放 `sessionStorage` 而不是 `localStorage` / IndexedDB：只活在这个标签页里，
 * 关掉即丢，和以前「凭据只在这个标签页」的边界一致；中继给页面的 CSP 只许
 * `script-src 'self'`、`connect-src 'self'`，读得到它的脚本本来就能用内存里的
 * 令牌发请求，多记两把刷新令牌不扩大 XSS 能做的事，只延长到刷新之后。
 */
export const HOSTED_RESUME_KEY = "armadra.hosted.resume";

interface ResumeRecord {
  readonly issuer: string;
  readonly cloudRefreshToken: string | null;
  /** 源 core 的刷新令牌，按源。 */
  readonly sources: Readonly<Record<string, string>>;
  /** 上次进的主机；还没进过是 `null`。 */
  readonly entered: { readonly sourceId: string; readonly name: string } | null;
  /** 访客记录的寿命（毫秒时刻，= 链接到期）；账号那份没有。 */
  readonly expiresAtMs?: number;
  /** 访客看到的分享：权限、主人 / 工作空间名；账号那份没有。 */
  readonly share?: GuestShare;
}

/** 访客加入的这份分享（顶栏显示用）。 */
export interface GuestShare {
  /** `viewer` / `editor` / `operator` / `driver`；不知道是空串。 */
  readonly role: string;
  /** 分享给你的工作空间 / 主机名；不知道是空串。 */
  readonly name: string;
  /** 主人名字；不知道是空串。 */
  readonly ownerName: string;
  /** 链接到期（毫秒时刻）。 */
  readonly expiresAtMs: number;
}

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readResume(
  storage: Storage | null,
  issuer: string,
  key: string = HOSTED_RESUME_KEY,
  now: number = Date.now(),
): ResumeRecord {
  const empty: ResumeRecord = {
    issuer,
    cloudRefreshToken: null,
    sources: {},
    entered: null,
  };
  try {
    const raw = storage?.getItem(key);
    if (!raw) return empty;
    const value = JSON.parse(raw) as Partial<ResumeRecord>;
    // 别的签发方留下的（同一来源不会有，但别信它）：不用。
    if (value.issuer !== issuer) return empty;
    // 访客记录到期即作废（连同存储里那份）。
    if (typeof value.expiresAtMs === "number" && value.expiresAtMs <= now) {
      storage?.removeItem(key);
      return empty;
    }
    const sources: Record<string, string> = {};
    for (const [id, token] of Object.entries(value.sources ?? {}))
      if (typeof token === "string" && token !== "") sources[id] = token;
    const entered = value.entered;
    const share = value.share;
    return {
      issuer,
      ...(typeof value.expiresAtMs === "number"
        ? { expiresAtMs: value.expiresAtMs }
        : {}),
      ...(share && typeof share === "object"
        ? {
            share: {
              role: typeof share.role === "string" ? share.role : "",
              name: typeof share.name === "string" ? share.name : "",
              ownerName:
                typeof share.ownerName === "string" ? share.ownerName : "",
              expiresAtMs:
                typeof share.expiresAtMs === "number" ? share.expiresAtMs : 0,
            },
          }
        : {}),
      cloudRefreshToken:
        typeof value.cloudRefreshToken === "string" &&
        value.cloudRefreshToken !== ""
          ? value.cloudRefreshToken
          : null,
      sources,
      entered:
        entered &&
        typeof entered.sourceId === "string" &&
        entered.sourceId !== ""
          ? {
              sourceId: entered.sourceId,
              name: typeof entered.name === "string" ? entered.name : "",
            }
          : null,
    };
  } catch {
    return empty;
  }
}

function writeResume(
  storage: Storage | null,
  record: ResumeRecord,
  key: string = HOSTED_RESUME_KEY,
): void {
  try {
    if (record.cloudRefreshToken === null) {
      storage?.removeItem(key);
      return;
    }
    storage?.setItem(key, JSON.stringify(record));
  } catch {
    /* 存不下只是刷新后要重新登录。 */
  }
}

/* ------------------------------- 访客保管处 ------------------------------- */

/** 访客记录的键前缀：`armadra.guest.<签发方>|<链接>`，按 签发方 + 链接 各一份。 */
export const GUEST_KEY_PREFIX = "armadra.guest.";

export function guestKey(issuer: string, linkId: string): string {
  return `${GUEST_KEY_PREFIX}${issuer}|${linkId}`;
}

function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 这个签发方下还没到期的访客记录的键；到期的顺手清掉。 */
export function guestKeys(
  storage: Storage | null,
  issuer: string,
  now: number = Date.now(),
): string[] {
  if (storage === null) return [];
  const prefix = `${GUEST_KEY_PREFIX}${issuer}|`;
  const keys: string[] = [];
  try {
    for (let at = 0; at < storage.length; at += 1) {
      const key = storage.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys.filter(
      (key) => readResume(storage, issuer, key, now).cloudRefreshToken !== null,
    );
  } catch {
    return [];
  }
}

/** 丢掉这个签发方下全部访客记录（账号登录是明确换身份）。 */
export function clearGuestRecords(
  storage: Storage | null,
  issuer: string,
): void {
  if (storage === null) return;
  try {
    const prefix = `${GUEST_KEY_PREFIX}${issuer}|`;
    const keys: string[] = [];
    for (let at = 0; at < storage.length; at += 1) {
      const key = storage.key(at);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* 清不掉只是下次刷新还试它。 */
  }
}

export interface SessionVaultOptions {
  /** 存储里的键；缺省是账号那一份 {@link HOSTED_RESUME_KEY}。 */
  readonly key?: string;
  /** 记录的寿命（毫秒时刻）；到期读不出来、写时带上。 */
  readonly expiresAtMs?: number;
  readonly now?: () => number;
}

export interface SessionRelayVault extends MemoryRelayVault {
  /** 记下（或忘掉）上次进的主机。 */
  rememberEntered(source: { sourceId: string; name: string } | null): void;
  /** 上次进的主机；没有可续的就是 `null`。 */
  entered(): { sourceId: string; name: string } | null;
  /** 访客的分享信息（只有访客那份记）。 */
  rememberShare(share: GuestShare): void;
  share(): GuestShare | null;
}

/**
 * 内存保管处加一层 `sessionStorage`：刷新令牌写穿，访问令牌只在内存。启动时
 * 从存储读回刷新令牌；源 core 的会话读回时访问令牌为空、已过期，用它的人
 * （`relay-access.ts`）会先轮换。
 */
export function createSessionRelayVault(
  issuer: string,
  storage: Storage | null = browserSessionStorage(),
  options: SessionVaultOptions = {},
): SessionRelayVault {
  const key = options.key ?? HOSTED_RESUME_KEY;
  const memory = createMemoryRelayVault();
  const stamp = (next: ResumeRecord): ResumeRecord =>
    options.expiresAtMs === undefined
      ? next
      : { ...next, expiresAtMs: options.expiresAtMs };
  let record = stamp(readResume(storage, issuer, key, options.now?.()));
  const save = (next: ResumeRecord) => {
    record = stamp(next);
    writeResume(storage, record, key);
  };
  const clear = () => {
    memory.clear();
    record = stamp({
      issuer,
      cloudRefreshToken: null,
      sources: {},
      entered: null,
    });
    try {
      storage?.removeItem(key);
    } catch {
      /* 没存下过。 */
    }
  };
  return {
    async cloudRefreshToken(of) {
      return (
        (await memory.cloudRefreshToken(of)) ??
        (of === issuer ? record.cloudRefreshToken : null)
      );
    },
    async saveCloudRefreshToken(of, refreshToken) {
      await memory.saveCloudRefreshToken(of, refreshToken);
      if (of === issuer) save({ ...record, cloudRefreshToken: refreshToken });
    },
    async forgetCloud(of) {
      await memory.forgetCloud?.(of);
      if (of === issuer) clear();
    },
    async session(sourceId) {
      const live = await memory.session(sourceId);
      if (live !== undefined) return live;
      const refreshToken = record.sources[sourceId];
      // 过期的空访问令牌：取用前一定先轮换。
      return refreshToken === undefined
        ? undefined
        : { accessToken: "", refreshToken, expiresAtMs: 1 };
    },
    async saveSession(sourceId, of, session) {
      await memory.saveSession(sourceId, of, session);
      if (record.sources[sourceId] !== session.refreshToken)
        save({
          ...record,
          sources: { ...record.sources, [sourceId]: session.refreshToken },
        });
    },
    rememberEntered(source) {
      save({ ...record, entered: source });
    },
    entered: () => (record.cloudRefreshToken === null ? null : record.entered),
    rememberShare(share) {
      save({ ...record, share });
    },
    share: () =>
      record.cloudRefreshToken === null ? null : (record.share ?? null),
    clear,
  };
}

/** 刷新之后续的结果：进了主机、登录还在但进不去（给目录与原因）、或要重新登录。 */
export type HostedResume =
  | { readonly kind: "entered" }
  | {
      readonly kind: "signedIn";
      readonly hosts: CloudSource[];
      readonly failure: HostedFailure;
    }
  | null;

/* --------------------------------- 状态 ---------------------------------- */

export interface HostedStatus {
  readonly state: SourceState;
  readonly lastError: SourceFailure | null;
  /**
   * 中继自己停了（不是来源主机下线）：`me.stream` 开过之后连不上中继超过
   * {@link RELAY_DOWN_AFTER_MS}。中继回来、流重开时落回 `false`。
   */
  readonly relayDown: boolean;
}

/** `me.stream` 断开多久还连不上中继，才算中继停了（重启、换节点的短暂断开不算）。 */
export const RELAY_DOWN_AFTER_MS = 4_000;

/** 链接没告诉到期时，访客记录最多留一周。 */
const GUEST_FALLBACK_MS = 7 * 24 * 3_600_000;

/** 登录、挑主机的失败原因；文案键 `remote.error.<原因>`。 */
export type HostedFailure =
  | "credentials"
  | "locked"
  | "rateLimited"
  | "challengeInvalid"
  | "unreachable"
  | "offline"
  | "unlinked"
  | "revoked"
  | "noSources"
  | "failed";

/** 远程服务与源的拒绝 → 原因。 */
export function hostedFailureOf(error: unknown): HostedFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof CloudError) {
    if (code === "credentials_invalid") return "credentials";
    if (code === "account_locked") return "locked";
    if (code === "rate_limited") return "rateLimited";
    if (code === "challenge_invalid" || code === "challenge_required")
      return "challengeInvalid";
  }
  if (code === SOURCE_ERROR.offline) return "offline";
  if (code === "cloud_account_unlinked" || code === "cloud_not_registered")
    return "unlinked";
  if (code === SOURCE_ERROR.revoked || code === SOURCE_ERROR.accessRevoked)
    return "revoked";
  if (code === SOURCE_ERROR.unreachable) return "unreachable";
  if (
    error instanceof TypeError ||
    (error as Error)?.name === "CloudTransportError"
  )
    return "unreachable";
  return "failed";
}

export interface HostedRelayOptions {
  readonly issuer: string;
  readonly cloud?: CloudOptions;
  /** 测试注入：造 `me.stream`。 */
  readonly createStream?: typeof createRemoteStream;
  /** 测试注入：装成本机源（缺省 `route-entry.ts`）。 */
  readonly enter?: typeof enterRoute;
  /** 测试注入：叫醒页面的流（缺省本机源上托管的流，即控制面）。 */
  readonly wake?: () => void;
  /** 测试注入：计时器（判断中继停了）。 */
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** 测试注入：把目录里其余的主机挂进页面源表（缺省 `mounts.ts`）。 */
  readonly mount?: typeof mountSiblingSources;
  /** 刷新后续上用的存储（缺省 `sessionStorage`；`null` = 只在内存）。 */
  readonly storage?: Storage | null;
  /** 访客刷新令牌的存储（缺省 `localStorage`；`null` = 只在内存）。 */
  readonly guestStorage?: Storage | null;
  /** 测试注入：现在的时刻（毫秒）。 */
  readonly now?: () => number;
}

/** 目录里的一台主机 → 经这个中继到达的源描述。 */
function relayedDescriptor(
  issuer: string,
  source: Pick<CloudSource, "sourceId" | "name">,
): SourceDescriptor {
  return {
    sourceId: source.sourceId,
    kind: "relayed",
    label: source.name,
    baseUrl: "",
    relayOrigin: issuer,
    cloudIssuer: issuer,
    fingerprint: "",
    orderIndex: 0,
  };
}

export interface HostedRelay {
  readonly issuer: string;
  readonly provider: CredentialProvider;
  /**
   * 口令登录远程服务，答它目录里的主机。远程服务要求挑战而没带令牌时抛
   * `CloudChallengeRequired`（带 siteKey）；`challengeToken` 是挑战组件交回的令牌。
   */
  signIn(
    account: string,
    password: string,
    challengeToken?: string,
  ): Promise<CloudSource[]>;
  /**
   * 把这台主机装成页面的本机源；失败抛（按 {@link hostedFailureOf} 显示）。
   * 登录时目录里的其余主机随后作为远程源挂进页面源表（同一个标签页同时挂多台）。
   */
  enter(source: Pick<CloudSource, "sourceId" | "name">): Promise<void>;
  /**
   * 按分享链接以访客加入（客户端包 §6.1，A4-3p）：匿名 `links.accept` → 访客的
   * 远程服务会话进保管处 → 经中继 `cloud/login` 带邀请令牌换源会话 → 同
   * {@link enter} 装成本机源。答加入的源。失败抛（远程服务的拒绝是 `CloudError`）。
   */
  join(link: {
    readonly linkId: string;
    readonly secret: string;
    readonly invitationToken: string;
  }): Promise<string>;
  /**
   * 刷新页面之后：用记下的刷新令牌静默续上远程服务，再进上次那台主机。没有
   * 记下的、刷新令牌被拒：`null`（重新登录）。
   */
  resume(): Promise<HostedResume>;
  /** 这个页面是不是以访客身份（分享链接）进来的；是就给那份分享，否则 `null`。 */
  guest(): GuestShare | null;
  readonly status: HostedStatus;
  subscribe(listener: () => void): () => void;
  /** 登出远程服务并丢掉全部凭据（内存与 `sessionStorage`）。 */
  signOut(): Promise<void>;
  dispose(): void;
}

export function createHostedRelay(options: HostedRelayOptions): HostedRelay {
  const { issuer } = options;
  const now = options.now ?? Date.now;
  const accountVault = createSessionRelayVault(
    issuer,
    options.storage === undefined ? browserSessionStorage() : options.storage,
  );
  const guestStorage =
    options.guestStorage === undefined
      ? browserLocalStorage()
      : options.guestStorage;
  // 背后的保管处：账号登录是 sessionStorage 那一份；按链接加入的访客是
  // localStorage 里按 签发方 + 链接 的那一份。下面各处都经这个代理读写。
  let backing: SessionRelayVault = accountVault;
  let guest = false;
  const vault: SessionRelayVault = {
    cloudRefreshToken: (of) => backing.cloudRefreshToken(of),
    saveCloudRefreshToken: (of, token) =>
      backing.saveCloudRefreshToken(of, token),
    forgetCloud: (of) => backing.forgetCloud?.(of) ?? Promise.resolve(),
    session: (sourceId) => backing.session(sourceId),
    saveSession: (sourceId, of, session) =>
      backing.saveSession(sourceId, of, session),
    rememberEntered: (source) => backing.rememberEntered(source),
    entered: () => backing.entered(),
    rememberShare: (share) => backing.rememberShare(share),
    share: () => backing.share(),
    clear: () => backing.clear(),
  };
  const useGuest = (key: string, expiresAtMs?: number) => {
    backing = createSessionRelayVault(issuer, guestStorage, {
      key,
      now,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    });
    guest = true;
    return backing;
  };
  const useAccount = () => {
    backing = accountVault;
    guest = false;
  };
  const cloudSessions = createCloudSessions({
    vault,
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
  });
  const relay = createRelayedAccess({
    vault,
    cloudSessions,
    device: () => browserDevice(),
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
  });
  const forced = new Set<string>();
  const cached = createCachedCredentialProvider(async (sourceId, via) => {
    if (via !== "relayed") throw new SourceError(SOURCE_ERROR.unreachable);
    return relay.access(issuer, sourceId, forced.delete(sourceId));
  });
  const provider: CredentialProvider = {
    getAccess: (sourceId, via) => cached.getAccess(sourceId, via),
    refresh(sourceId, via) {
      forced.add(sourceId);
      return cached.refresh(sourceId, via);
    },
    invalidate: (sourceId) => cached.invalidate(sourceId),
  };

  let status: HostedStatus = {
    state: "idle",
    lastError: null,
    relayDown: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: HostedStatus) => {
    if (
      status.state === next.state &&
      status.lastError?.code === next.lastError?.code &&
      status.relayDown === next.relayDown
    )
      return;
    status = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* 一个订阅者出错不拖垮别的。 */
      }
    }
  };
  const setStatus = (state: SourceState, lastError: SourceFailure | null) =>
    publish({ ...status, state, lastError });

  /*
   * 中继自己停了：`me.stream` 就连在中继上，开过之后一直回不到 `open` 就是中继
   * 不通。主机下线时这条流照常开着（中继推 `sourceOffline`），两者由此分开。
   */
  const later =
    options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let streamOpened = false;
  let relayTimer: unknown = null;
  const stopRelayTimer = () => {
    if (relayTimer !== null) cancel(relayTimer);
    relayTimer = null;
  };
  const onStreamState = (state: ManagedSocketState) => {
    if (state === "open") {
      streamOpened = true;
      stopRelayTimer();
      publish({ ...status, relayDown: false });
      return;
    }
    // 自己关的、凭据失效的：不是中继的事。
    if (state === "closed" || state === "unauthorized") {
      stopRelayTimer();
      return;
    }
    if (!streamOpened || status.relayDown || relayTimer !== null) return;
    relayTimer = later(() => {
      relayTimer = null;
      publish({ ...status, relayDown: true });
    }, RELAY_DOWN_AFTER_MS);
  };

  let entered: EnteredRoute | null = null;
  let stream: RemoteStream | null = null;
  let current: string | null = null;
  /** 登录时远程服务答的目录（访客加入时只有那一台）。 */
  let directory: readonly CloudSource[] = [];
  let siblings: SiblingMount | null = null;
  /** 一起挂上的其余主机（源表里的远程源）。 */
  const siblingTargets = () =>
    siblings === null
      ? []
      : siblings.registry
          .list()
          .filter((connection) => connection.descriptor.kind !== "local");
  // 本机源（就是这台主机）上托管的流——控制面——在 4404 之后等着：叫醒它。
  const wake = options.wake ?? (() => void sourceRegistry().local().connect());

  /** `me.stream` 的事件落到当前这台主机上。 */
  const target: StreamTarget = {
    get status() {
      return status;
    },
    async connect() {
      // 主机回来了：隧道是新的，会话在 core 的库里还在；叫醒在退避里的流。
      setStatus("ready", null);
      wake();
    },
    revoke(failure) {
      provider.invalidate(current ?? "");
      // 访客的访问被收回 / 令牌被拒：记下的那份不再有用，刷新后别再试它。
      if (
        guest &&
        (failure.code === SOURCE_ERROR.accessRevoked ||
          failure.code === SOURCE_ERROR.revoked ||
          failure.code === SOURCE_ERROR.unauthorized)
      )
        vault.clear();
      setStatus("unauthorized", failure);
    },
  };

  /** 流（重）新打开：对一次目录，补上断开期间错过的上下线。 */
  const resync = async () => {
    if (current === null) return;
    try {
      const listed = await cloudSources(
        issuer,
        await cloudSessions.access(issuer),
        options.cloud,
      );
      const row = listed.find((item) => item.sourceId === current);
      if (row === undefined) {
        target.revoke({ code: SOURCE_ERROR.accessRevoked, message: "" });
        return;
      }
      // 在线：不论之前看到的是什么都叫醒一次——中继重启时它把经它的流以 4404
      // 收尾，而这条事件流断着，没收到过下线也就收不到上线。
      if (row.online && status.state !== "unauthorized") await target.connect();
      else if (!row.online && status.state === "ready")
        setStatus("waitingForSource", {
          code: SOURCE_ERROR.offline,
          message: "",
        });
    } catch {
      /* 目录取不到：等下一次事件。 */
    }
  };

  const startStream = () => {
    stream?.close();
    stream = (options.createStream ?? createRemoteStream)({
      issuer,
      auth: cloudSessions,
      ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
      onEvent(event) {
        if (!("sourceId" in event)) return;
        if (event.sourceId !== current) {
          applyMeStreamEvent(event, siblings?.registry.get(event.sourceId));
          return;
        }
        if (event.type === "sourceOffline") {
          setStatus("waitingForSource", {
            code: SOURCE_ERROR.offline,
            message: "",
          });
          return;
        }
        applyMeStreamEvent(event, target);
      },
      onStateChange: onStreamState,
      onOpen: () => {
        void resync();
        resyncTargets(siblingTargets());
      },
    });
  };

  /**
   * 用背后保管处记下的东西续上：进了上次那台（或给目录与原因）；这份记录
   * 没用了（没记、令牌被拒、那台不在目录里了）答 `undefined`，由调用方换下一份；
   * 连不上中继答 `null`（不丢记录，回登录页）。
   */
  const resumeWith = async (): Promise<HostedResume | undefined> => {
    const last = vault.entered();
    if (last === null) return undefined;
    let listed: CloudSource[];
    try {
      listed = await cloudSources(
        issuer,
        await cloudSessions.access(issuer),
        options.cloud,
      );
    } catch (error) {
      const failure = hostedFailureOf(error);
      // 刷新令牌被拒（已从保管处忘掉）：重新登录。连不上：也只能先登录页。
      if (failure === "unreachable") return null;
      vault.clear();
      return undefined;
    }
    directory = guest ? [] : listed;
    const row = listed.find((item) => item.sourceId === last.sourceId);
    if (row === undefined) {
      // 访客的访问被收回了：那份记录作废；账号的给目录与原因。
      if (guest) return undefined;
      return { kind: "signedIn", hosts: listed, failure: "revoked" };
    }
    try {
      await hosted.enter(row);
      return { kind: "entered" };
    } catch (error) {
      const failure = hostedFailureOf(error);
      if (guest && failure === "revoked") return undefined;
      return { kind: "signedIn", hosts: listed, failure };
    }
  };

  const hosted: HostedRelay = {
    issuer,
    provider,
    async join(link) {
      const accepted = await cloudAcceptLink(
        issuer,
        link.linkId,
        link.secret,
        browserDevice(),
        options.cloud,
      );
      const guestSession = accepted.guestSession;
      if (guestSession.refreshToken === undefined)
        throw new CloudError(502, "bad_response");
      // 寿命 = 链接到期；问不到就取访客会话的到期，再不行一周。
      const info = await cloudLinkInfo(
        issuer,
        link.linkId,
        options.cloud,
      ).catch(() => null);
      const expiresAtMs =
        info !== null && info.expiresAtMs > now()
          ? info.expiresAtMs
          : guestSession.expiresAtMs > now()
            ? guestSession.expiresAtMs
            : now() + GUEST_FALLBACK_MS;
      useGuest(guestKey(issuer, link.linkId), expiresAtMs);
      try {
        await vault.saveCloudRefreshToken(issuer, guestSession.refreshToken);
        cloudSessions.adopt(
          issuer,
          guestSession.accessToken,
          guestSession.accessExpiresAtMs,
        );
        const login = await coreCloudLogin(
          accepted.relayBaseUrl,
          accepted.relayToken,
          accepted.assertion,
          link.invitationToken,
          options.cloud,
        );
        await vault.saveSession(accepted.sourceId, issuer, {
          accessToken: login.native.accessToken,
          refreshToken: login.native.refreshToken,
          expiresAtMs: login.expiresAtUnixMs,
          ...(login.csrfToken === undefined
            ? {}
            : { csrfToken: login.csrfToken }),
        });
      } catch (error) {
        vault.clear();
        useAccount();
        throw error;
      }
      // 名字是锦上添花：访客的目录里只有这一台，取不到就空着。
      const rows = await cloudSources(
        issuer,
        guestSession.accessToken,
        options.cloud,
      ).catch(() => [] as CloudSource[]);
      const name =
        rows.find((row) => row.sourceId === accepted.sourceId)?.name ?? "";
      // 访客只挂链接指向的这一台。
      directory = [];
      vault.rememberShare({
        role: info?.role ?? "",
        name: name || info?.sourceName || "",
        ownerName: "",
        expiresAtMs,
      });
      await hosted.enter({ sourceId: accepted.sourceId, name });
      return accepted.sourceId;
    },
    async signIn(account, password, challengeToken) {
      const session = await cloudLogin(
        issuer,
        account,
        password,
        browserDevice(),
        options.cloud,
        challengeToken,
      );
      if (session.refreshToken === undefined)
        throw new CloudError(502, "bad_response");
      // 账号登录是明确换身份：访客记录不再续。
      clearGuestRecords(guestStorage, issuer);
      useAccount();
      await vault.saveCloudRefreshToken(issuer, session.refreshToken);
      cloudSessions.adopt(
        issuer,
        session.accessToken,
        session.accessExpiresAtMs,
      );
      directory = await cloudSources(
        issuer,
        session.accessToken,
        options.cloud,
      );
      return [...directory];
    },
    async enter(source) {
      const descriptor = relayedDescriptor(issuer, source);
      setStatus("connecting", null);
      const store: HostedSessionStore = {
        load: () => vault.session(source.sourceId),
        save: (session) =>
          void vault.saveSession(source.sourceId, issuer, session),
        // 只在身份面登出时调：刷新之后不该再静默登回去。
        clear: () => {
          provider.invalidate(source.sourceId);
          vault.clear();
        },
        recover: async () => {
          try {
            await provider.refresh(source.sourceId, "relayed");
            return true;
          } catch {
            return false;
          }
        },
      };
      try {
        entered = await (options.enter ?? enterRoute)({
          descriptor,
          provider,
          useRoute(route) {
            setHostedSession(store);
            setHostedRuntimeBase(route.access.httpBase);
          },
          restore: restoreHostedCredentials,
          onRenewed(access) {
            if (access !== null && status.state !== "ready")
              setStatus("ready", null);
          },
        });
      } catch (error) {
        const failure = {
          code:
            (error as { code?: unknown })?.code &&
            typeof (error as { code: unknown }).code === "string"
              ? (error as { code: string }).code
              : SOURCE_ERROR.unreachable,
          message: "",
        };
        setStatus(
          failure.code === SOURCE_ERROR.offline
            ? "waitingForSource"
            : "offline",
          failure,
        );
        throw error;
      }
      if (!(await restoreHostedCredentials())) {
        setStatus("unauthorized", {
          code: SOURCE_ERROR.unauthorized,
          message: "",
        });
        throw new SourceError(SOURCE_ERROR.unauthorized);
      }
      current = source.sourceId;
      vault.rememberEntered({
        sourceId: source.sourceId,
        name: source.name,
      });
      setStatus("ready", null);
      siblings?.dispose();
      siblings = (options.mount ?? mountSiblingSources)({
        primary: descriptor,
        siblings: directory.map((row) => relayedDescriptor(issuer, row)),
        provider,
      });
      startStream();
    },
    async resume() {
      // 先试访客的记录（按链接各一份，没到期的），再回账号登录。
      for (const key of guestKeys(guestStorage, issuer, now())) {
        useGuest(key);
        const resumed = await resumeWith();
        if (resumed !== undefined) return resumed;
        vault.clear();
      }
      useAccount();
      return (await resumeWith()) ?? null;
    },
    guest: () => (guest ? vault.share() : null),
    get status() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async signOut() {
      const token = await cloudSessions.access(issuer).catch(() => null);
      if (token !== null) await cloudLogout(issuer, token, options.cloud);
      this.dispose();
    },
    dispose() {
      stream?.close();
      stream = null;
      stopRelayTimer();
      streamOpened = false;
      siblings?.dispose();
      siblings = null;
      directory = [];
      entered?.dispose();
      entered = null;
      vault.clear();
      if (current !== null) provider.invalidate(current);
      current = null;
      publish({ state: "idle", lastError: null, relayDown: false });
    },
  };
  return hosted;
}

/* ------------------------------- 页面那一个 ------------------------------- */

let active: HostedRelay | null = null;

/** 中继托管页面上的那一个（入口建，界面读状态）；别的页面是 `null`。 */
export function hostedRelay(): HostedRelay | null {
  return active;
}

export function startHostedRelay(host: RelayHost): HostedRelay {
  active?.dispose();
  active = createHostedRelay({ issuer: host.issuer });
  return active;
}

/** 测试换掉页面那一个。 */
export function resetHostedRelay(next: HostedRelay | null = null): void {
  active = next;
}
