import {
  type CloudAccept,
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
import {
  type E2eChannels,
  e2eChannels,
  fingerprintPrefix,
  sealedJoinOptions,
} from "./e2e/manager";
import type { mountSiblingSources } from "./mounts";
import { createCloudSessions, createRelayedAccess } from "./relay-access";
import {
  type GuestShare,
  type SessionRelayVault,
  browserLocalStorage,
  browserSessionStorage,
  clearGuestRecords,
  createSessionRelayVault,
  guestKey,
  guestKeys,
} from "./relay-vault";
import { type RelayedStatus, createRelayedEntry } from "./relayed-entry";
import { setRelayedPage } from "./relayed-page";
import type { createRemoteStream } from "./remote-stream";
import type { enterRoute } from "./route-entry";
import { type CredentialProvider, SOURCE_ERROR, SourceError } from "./types";

export {
  type GuestShare,
  type MemoryRelayVault,
  type SessionRelayVault,
  type SessionVaultOptions,
  GUEST_KEY_PREFIX,
  HOSTED_RESUME_KEY,
  clearGuestRecords,
  createMemoryRelayVault,
  createSessionRelayVault,
  guestKey,
  guestKeys,
  hasGuestRecord,
} from "./relay-vault";
export { RELAY_DOWN_AFTER_MS } from "./relayed-entry";
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

/** 刷新之后续的结果：进了主机、登录还在但进不去（给目录与原因）、或要重新登录。 */
export type HostedResume =
  | { readonly kind: "entered" }
  | {
      readonly kind: "signedIn";
      readonly hosts: CloudSource[];
      readonly failure: HostedFailure;
    }
  | null;

/**
 * 只续一条链接的结果：{@link HostedResume} 之外多一种「这条记录没有了」（没有、过期、被收回）——
 * 与 `null`（连不上中继，记录还留着）分开，落地页据此决定是保留「打开」还是回到「加入」。
 */
export type LinkResume = HostedResume | { readonly kind: "gone" };

/* --------------------------------- 状态 ---------------------------------- */

/** 托管页的状态：与 `/h/` 同一份（{@link RelayedStatus}）。 */
export type HostedStatus = RelayedStatus;

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
    if (code === "challenge_invalid" || code === "challenge_required")
      return "challengeInvalid";
  }
  // 经中继登录（`relay-access.ts`）把限流原码带成 `SourceError`，远程服务直答的是 `CloudError`。
  if (code === "rate_limited") return "rateLimited";
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
  /** 端到端通道（契约 §78）；不给不开通道（测试），页面入口给。 */
  readonly e2e?: E2eChannels;
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
   * `accepted`：调用方已经（带着云会话）接受过链接，直接用这份结果，不再匿名接受
   * （云端控制台的 SaaS 落地页，`cloud/auth/LinkPage.tsx`）。
   */
  join(
    link: {
      readonly linkId: string;
      readonly secret: string;
      readonly invitationToken: string;
      /** 链接片段第三段：core 身份指纹前缀（契约 §80）。 */
      readonly identityFp?: string;
    },
    accepted?: CloudAccept,
  ): Promise<string>;
  /**
   * 刷新页面之后：用记下的刷新令牌静默续上远程服务，再进上次那台主机。没有
   * 记下的、刷新令牌被拒：`null`（重新登录）。
   */
  resume(): Promise<HostedResume>;
  /**
   * 只续这一条分享链接的访客记录（分享链接落地页的「打开」）：不遍历别的链接的记录，
   * 也不退回账号记录。没进去时页面一律退回账号身份：记录没有 / 被收回答 `{ kind: "gone" }`
   * （作废那份记录）；连不上中继答 `null`、进主机失败答 `signedIn`，两者记录都留着。
   */
  resumeLink(linkId: string): Promise<LinkResume>;
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
  const switchToGuest = (key: string, expiresAtMs?: number) => {
    backing = createSessionRelayVault(issuer, guestStorage, {
      key,
      now,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    });
    guest = true;
    return backing;
  };
  const switchToAccount = () => {
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
    ...(options.e2e === undefined ? {} : { e2e: options.e2e }),
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

  /** 登录时远程服务答的目录（访客加入时只有那一台）。 */
  let directory: readonly CloudSource[] = [];
  const entry = createRelayedEntry({
    issuer,
    provider,
    streamAuth: cloudSessions,
    listSources: async () =>
      cloudSources(issuer, await cloudSessions.access(issuer), options.cloud),
    sessions: {
      load: (sourceId) => vault.session(sourceId),
      save: (sourceId, session) =>
        void vault.saveSession(sourceId, issuer, session),
      clear: () => vault.clear(),
    },
    directory: () => directory,
    onEntered: (source) =>
      vault.rememberEntered({ sourceId: source.sourceId, name: source.name }),
    onRevoked(failure) {
      // 访客的访问被收回 / 令牌被拒：记下的那份不再有用，刷新后别再试它。
      if (
        guest &&
        (failure.code === SOURCE_ERROR.accessRevoked ||
          failure.code === SOURCE_ERROR.revoked ||
          failure.code === SOURCE_ERROR.unauthorized)
      )
        vault.clear();
    },
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
    ...(options.createStream === undefined
      ? {}
      : { createStream: options.createStream }),
    ...(options.enter === undefined ? {} : { enter: options.enter }),
    ...(options.wake === undefined ? {} : { wake: options.wake }),
    ...(options.setTimeout === undefined
      ? {}
      : { setTimeout: options.setTimeout }),
    ...(options.clearTimeout === undefined
      ? {}
      : { clearTimeout: options.clearTimeout }),
    ...(options.mount === undefined ? {} : { mount: options.mount }),
  });

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
    async join(link, acceptedAlready) {
      // 控制台页面自己带会话接受（让云端记到账号上、过「要登录」的设置），接受的结果传进来；
      // 其余（个人中转的落地页）在这里匿名接受。
      const accepted =
        acceptedAlready ??
        (await cloudAcceptLink(
          issuer,
          link.linkId,
          link.secret,
          browserDevice(),
          options.cloud,
        ));
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
      switchToGuest(guestKey(issuer, link.linkId), expiresAtMs);
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
          await sealedJoinOptions(options.e2e, options.cloud, {
            issuer,
            sourceId: accepted.sourceId,
            base: accepted.relayBaseUrl,
            relayToken: accepted.relayToken,
            invitationToken: link.invitationToken,
            ...(fingerprintPrefix(link.identityFp, accepted.identityFp) ===
            undefined
              ? {}
              : {
                  fingerprintPrefix: fingerprintPrefix(
                    link.identityFp,
                    accepted.identityFp,
                  )!,
                }),
          }),
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
        switchToAccount();
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
        ownerName: info?.ownerName ?? "",
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
      switchToAccount();
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
    enter: (source) => entry.enter(source),
    async resume() {
      // 先试访客的记录（按链接各一份，没到期的），再回账号登录。
      for (const key of guestKeys(guestStorage, issuer, now())) {
        switchToGuest(key);
        const resumed = await resumeWith();
        if (resumed !== undefined) return resumed;
        vault.clear();
      }
      switchToAccount();
      return (await resumeWith()) ?? null;
    },
    async resumeLink(linkId) {
      const key = guestKey(issuer, linkId);
      if (!guestKeys(guestStorage, issuer, now()).includes(key))
        return { kind: "gone" };
      switchToGuest(key);
      const resumed = await resumeWith();
      if (resumed?.kind === "entered") return resumed;
      // 没进去（连不上中继、进主机失败、记录作废）：页面不能停在访客身份上。
      if (resumed === undefined) vault.clear();
      switchToAccount();
      return resumed === undefined ? { kind: "gone" } : resumed;
    },
    guest: () => (guest ? vault.share() : null),
    get status() {
      return entry.status;
    },
    subscribe: (listener) => entry.subscribe(listener),
    async signOut() {
      const token = await cloudSessions.access(issuer).catch(() => null);
      if (token !== null) await cloudLogout(issuer, token, options.cloud);
      this.dispose();
    },
    dispose() {
      directory = [];
      entry.signOut();
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
  active = createHostedRelay({
    issuer: host.issuer,
    e2e: e2eChannels(() => browserDevice().name),
  });
  setRelayedPage(active);
  return active;
}

/** 测试换掉页面那一个。 */
export function resetHostedRelay(next: HostedRelay | null = null): void {
  active = next;
  setRelayedPage(next);
}
