import {
  MIN_CORE_VERSION_ROLE_ONLY_ASSERTION,
  MIN_CORE_VERSION_TEAM_ASSERTION,
} from "@armadra/platform-protocol";

import {
  type IdentitySession,
  logoutIdentity,
  restoreHostedCredentials,
  resumeIdentity,
} from "../api/identity";
import type { CloudClient } from "../cloud/api/client";
import { browserDevice } from "./cloud-client";
import { createBrowserCloudCredentialProvider } from "./credentials";
import { type E2eChannels, e2eChannels, setApprovalHint } from "./e2e/manager";
import {
  type ChannelLike,
  HOST_KEY_PREFIX,
  clearHostSessions,
  hostSessionKey,
  isCloudSessionMessage,
  openCloudSessionChannel,
} from "./cloud-session-channel";
import { browserSessionStorage } from "./relay-vault";
import type { RelaySession } from "./relay-access";
import {
  type RelayedEntry,
  type RelayedEntryOptions,
  type RelayedStatus,
  createRelayedEntry,
} from "./relayed-entry";
import { setRelayedPage } from "./relayed-page";
import {
  type ReloginSchedulerOptions,
  createReloginScheduler,
} from "./relogin";
import { type MeStreamEvent, createRemoteStream } from "./remote-stream";
import { SOURCE_ERROR, SourceError } from "./types";

/**
 * 控制台的 `/h/<hostId>`（设计 saas-host-open §2）：用控制台的 Cookie 会话把一台主机装成
 * 页面的本机源。与个人中转托管页（`hosted.ts`）共用 `relayed-entry.ts`，这里只给三件事——
 * 怎样要断言（`sources.assertion`，Cookie）、怎样换 `me.stream` 的票（`me.streamTicket`）、
 * 怎样列目录（只这一台，`sources.get`）——外加：
 *
 * - **会话保存**：访问令牌只在内存；刷新令牌、CSRF 与会话主体记在本标签页 `sessionStorage`，
 *   键 `armadra.host.<控制台账号>.<主机>`，刷新页面先 `session/refresh`，不必再 `cloud/login`。
 *   进入时键里的账号必须是当前 `me.get` 的账号，续上的会话主体必须是记下的那位。
 * - **登出广播**：`BroadcastChannel("armadra.cloud.session")`——控制台登出 / 换账号时各 `/h/`
 *   标签页尽力 `session/logout`、清自己那份、盖上「已登出」；复制出的标签页用它认领同一份记录。
 * - **授予同步**：`grantChanged`（这台）与自己的 `memberChanged` 去抖合并后重登（§2.3）。
 * - **失败态与版本门**：断言答 `source_access_denied` 时按 `sources.get` 的 `coreVersion`
 *   分出「版本太旧」与「没有权限」（§2.5）。
 */

/** 登出经通道吊销主机侧会话最多等多久。 */
export const LOGOUT_TIMEOUT_MS = 3_000;
/** 复制出的标签页等多久没人认领就用这份记录。 */
export const CLAIM_WAIT_MS = 300;
/** 限流时多久后再试。 */
export const RATE_LIMIT_RETRY_MS = 20_000;

interface HostRecord {
  readonly refreshToken: string;
  readonly csrfToken?: string;
  /** 这份会话的主体（续上后核对）。 */
  readonly principalId?: string;
}

function readRecord(
  storage: Storage | null,
  key: string,
): HostRecord | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<HostRecord>;
    if (typeof value.refreshToken !== "string" || value.refreshToken === "")
      return undefined;
    return {
      refreshToken: value.refreshToken,
      ...(typeof value.csrfToken === "string"
        ? { csrfToken: value.csrfToken }
        : {}),
      ...(typeof value.principalId === "string"
        ? { principalId: value.principalId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function writeRecord(
  storage: Storage | null,
  key: string,
  record: HostRecord | null,
): void {
  try {
    if (record === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(record));
  } catch {
    /* 存不下只是刷新后要重新登录。 */
  }
}

/* ------------------------------- 版本门 ---------------------------------- */

function parseVersion(text: string): number[] | null {
  const found = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return found === null ? null : found.slice(1, 4).map(Number);
}

/** `a < b`（只比 major.minor.patch）；认不出的版本不算旧。 */
export function versionBelow(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return false;
  for (let at = 0; at < 3; at += 1) {
    if (left[at]! !== right[at]!) return left[at]! < right[at]!;
  }
  return false;
}

export type HostDetail = Awaited<ReturnType<CloudClient["sources"]["get"]>>;

/**
 * 控制面版本门对旧主机答的也是 `source_access_denied`（`grants/policy.go` 的 `versionGate`）：
 * 团队主机按 {@link MIN_CORE_VERSION_TEAM_ASSERTION}，个人空间里别人的主机按
 * {@link MIN_CORE_VERSION_ROLE_ONLY_ASSERTION}；自己的个人主机没有门。
 */
export function hostTooOld(detail: HostDetail): boolean {
  if (detail.space?.kind === "team")
    return versionBelow(detail.coreVersion, MIN_CORE_VERSION_TEAM_ASSERTION);
  if (detail.owner) return false;
  return versionBelow(detail.coreVersion, MIN_CORE_VERSION_ROLE_ONLY_ASSERTION);
}

/* --------------------------------- 状态 ---------------------------------- */

/** `/h/` 的失败码（文案键 `cloud.host.error.<码>`）。 */
export const HOST_FAILURE = {
  notFound: "not_found",
  revoked: "source_revoked",
  tooOld: "source_too_old",
  denied: "source_access_denied",
  teamSuspended: "team_suspended",
  deviceRejected: "device_rejected",
  identityChanged: "identity_changed",
  e2eUnsupported: "e2e_unsupported",
  unlinked: "cloud_account_unlinked",
  deviceUnavailable: "e2e_device_unavailable",
  failed: "failed",
} as const;

const KNOWN_FAILURES = new Set<string>(Object.values(HOST_FAILURE));

export type HostView =
  | { readonly kind: "connecting"; readonly rateLimited?: boolean }
  /** 没有控制台会话：去 `/login?next=/h/<host>`。 */
  | { readonly kind: "login" }
  | {
      readonly kind: "offline";
      readonly lastSeenAtMs: number | null;
    }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "entered" }
  /** 进去之后控制台的 Cookie 会话没了：冻结、给「重新登录」，回来后重试。 */
  | { readonly kind: "expired" }
  /** 本页或别的标签页登出、换了账号。 */
  | { readonly kind: "signedOut" };

export interface HostInfo {
  readonly name: string;
  /** 控制台里这台主机的页面（`/t/<团队>/hosts/<host>` 或 `/me/hosts/<host>`）。 */
  readonly consoleHref: string;
  /** 团队主机还是个人空间。 */
  readonly space: "team" | "personal";
  /** 控制台说你是主人。 */
  readonly owner: boolean;
}

/** 身份面会话是不是本机 owner（有 `settings:write`）。 */
export function isLocalOwner(session: IdentitySession | null): boolean {
  if (session === null) return false;
  if (session.device.role !== "member") return true;
  return session.scopes.some(
    (scope) =>
      scope.permission === "settings:write" && scope.workspaceId === "",
  );
}

export interface ConsoleHostOptions {
  readonly hostId: string;
  /** 控制台所在来源，也是断言的签发方。 */
  readonly issuer: string;
  readonly client: CloudClient;
  /** 会话记录（缺省 `sessionStorage`）。 */
  readonly storage?: Storage | null;
  /** 跨标签页广播（缺省 `BroadcastChannel`）。 */
  readonly channel?: ChannelLike | null;
  readonly e2e?: E2eChannels;
  /** 测试注入：身份面（核对主体、登出）。 */
  readonly identity?: {
    resume(): Promise<IdentitySession | null>;
    logout(): Promise<void>;
    restore(notify: boolean): Promise<boolean>;
  };
  /** 测试注入：重登去抖的计时。 */
  readonly scheduler?: Omit<ReloginSchedulerOptions, "run">;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly tabId?: string;
  /** 透传给 `relayed-entry.ts` 的测试注入。 */
  readonly entry?: Pick<
    RelayedEntryOptions,
    "enter" | "createStream" | "mount" | "wake" | "cloud"
  >;
  readonly now?: () => number;
}

export interface ConsoleHost {
  readonly hostId: string;
  readonly issuer: string;
  readonly view: HostView;
  readonly status: RelayedStatus;
  readonly info: HostInfo | null;
  /** 控制台说你是主人，但主机侧会话不是本机 owner（§2.6）。 */
  readonly ownerMismatch: boolean;
  subscribe(listener: () => void): () => void;
  /** 走一遍进入流程（失败落在 {@link view}，不抛）。 */
  open(): Promise<void>;
  /** 本页「登出」：经通道 `session/logout`，再删本条记录。 */
  signOut(): Promise<void>;
  guest(): null;
  dispose(): void;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

export function createConsoleHost(options: ConsoleHostOptions): ConsoleHost {
  const { hostId, issuer, client } = options;
  const storage =
    options.storage === undefined ? browserSessionStorage() : options.storage;
  const channel =
    options.channel === undefined ? openCloudSessionChannel() : options.channel;
  const identity = options.identity ?? {
    resume: resumeIdentity,
    logout: logoutIdentity,
    restore: restoreHostedCredentials,
  };
  const later =
    options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tabId =
    options.tabId ??
    globalThis.crypto?.randomUUID?.() ??
    `${Math.random()}`.slice(2);

  let view: HostView = { kind: "connecting" };
  let info: HostInfo | null = null;
  let detail: HostDetail | null = null;
  let accountId: string | null = null;
  let ownerMismatch = false;
  /** 续上的会话主体与记下的不符（记录已丢）：本次进入改用 `cloud/login` 再试一次。 */
  let principalChanged = false;
  let disposed = false;
  /** 进过主机（路由装着）：再次 `open()` 前要先卸下。 */
  let wasEntered = false;
  /** 登出了（本页或别处）：凭据提供方不再要断言。 */
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* 一个订阅者出错不拖垮别的。 */
      }
    }
  };
  const setView = (next: HostView) => {
    view = next;
    publish();
  };

  /* ----------------------------- 会话记录 ----------------------------- */

  const key = () =>
    accountId === null ? null : hostSessionKey(accountId, hostId);
  /** 这一页里最新的会话（访问令牌只在这里）。 */
  let live: RelaySession | undefined;
  const sessions = {
    async load(sourceId: string): Promise<RelaySession | undefined> {
      if (sourceId !== hostId) return undefined;
      if (live !== undefined) return live;
      const at = key();
      const record = at === null ? undefined : readRecord(storage, at);
      // 过期的空访问令牌：取用前一定先轮换。
      return record === undefined
        ? undefined
        : {
            accessToken: "",
            refreshToken: record.refreshToken,
            expiresAtMs: 1,
            ...(record.csrfToken === undefined
              ? {}
              : { csrfToken: record.csrfToken }),
          };
    },
    save(sourceId: string, session: RelaySession): void {
      if (sourceId !== hostId) return;
      live = session;
      const at = key();
      if (at === null) return;
      const before = readRecord(storage, at);
      writeRecord(storage, at, {
        refreshToken: session.refreshToken,
        ...(session.csrfToken === undefined
          ? {}
          : { csrfToken: session.csrfToken }),
        ...(before?.principalId === undefined
          ? {}
          : { principalId: before.principalId }),
      });
    },
    clear(): void {
      live = undefined;
      const at = key();
      if (at !== null) writeRecord(storage, at, null);
    },
  };

  /* ------------------------------ 凭据 ------------------------------- */

  const e2e = options.e2e ?? e2eChannels(() => browserDevice().name);
  const provider = createBrowserCloudCredentialProvider({
    client: {
      sources: {
        async assertion(input) {
          // 登出中 / 已登出：不再要断言，画布里还在跑的请求不能借刷新把会话登回来。
          if (closed) throw new SourceError(SOURCE_ERROR.unauthorized);
          try {
            return await client.sources.assertion(input);
          } catch (error) {
            // 控制台的 Cookie 会话没了（客户端已经走过刷新锁）：不整页跳走，冻结等重新登录。
            if (statusOf(error) === 401 && view.kind === "entered")
              setView({ kind: "expired" });
            if (
              codeOf(error) === SOURCE_ERROR.accessRevoked &&
              detail !== null &&
              hostTooOld(detail)
            )
              throw new SourceError(HOST_FAILURE.tooOld);
            throw error;
          }
        },
      },
    },
    issuer,
    e2e,
    sessions,
    label: () => info?.name ?? "",
    ...(options.entry?.cloud === undefined
      ? {}
      : { cloud: options.entry.cloud }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  /* ------------------------------ 进入 ------------------------------- */

  /** 续上的会话核对：主体与记下的一致；记下这一位；顺带看是不是本机 owner。 */
  const verify = async () => {
    const session = await identity.resume();
    if (session === null) throw new SourceError(SOURCE_ERROR.unauthorized);
    const principalId = session.device.principalId;
    const at = key();
    const record = at === null ? undefined : readRecord(storage, at);
    if (
      record?.principalId !== undefined &&
      principalId !== "" &&
      record.principalId !== principalId
    ) {
      sessions.clear();
      provider.clear();
      principalChanged = true;
      throw new SourceError(SOURCE_ERROR.unauthorized);
    }
    if (at !== null && record !== undefined && principalId !== "")
      writeRecord(storage, at, { ...record, principalId });
    ownerMismatch = info?.owner === true && !isLocalOwner(session);
  };

  const scheduler = createReloginScheduler({
    ...options.scheduler,
    run: async () => {
      try {
        await provider.relogin(hostId);
        await identity.restore(true);
      } catch (error) {
        const code = codeOf(error);
        if (
          code === HOST_FAILURE.teamSuspended ||
          code === SOURCE_ERROR.accessRevoked ||
          code === SOURCE_ERROR.revoked
        ) {
          sessions.clear();
          setView({ kind: "failed", code });
        }
      }
    },
  });

  const onStreamEvent = (event: MeStreamEvent) => {
    if (event.type === "grantChanged" && event.sourceId === hostId)
      scheduler.request(hostId);
    if (
      event.type === "memberChanged" &&
      event.accountId !== undefined &&
      event.accountId === accountId &&
      (detail?.space?.kind !== "team" || detail.space.teamId === event.teamId)
    )
      scheduler.request(hostId);
  };

  const entry: RelayedEntry = createRelayedEntry({
    issuer,
    provider,
    streamTicket: async () => (await client.me.streamTicket({})).ticket,
    listSources: async () => {
      try {
        const row = await client.sources.get({ sourceId: hostId });
        return [{ ...row, sourceId: hostId }] as never;
      } catch (error) {
        if (codeOf(error) === HOST_FAILURE.notFound) return [];
        throw error;
      }
    },
    sessions: {
      load: (sourceId) => sessions.load(sourceId),
      save: (sourceId, session) => sessions.save(sourceId, session),
      clear: () => sessions.clear(),
    },
    verify,
    onStreamEvent,
    onRevoked(failure) {
      sessions.clear();
      setView({
        kind: "failed",
        code:
          failure.code === SOURCE_ERROR.revoked
            ? HOST_FAILURE.revoked
            : HOST_FAILURE.denied,
      });
    },
    ...options.entry,
  });

  /* ---------------------------- 离线等上线 ---------------------------- */

  let waiting: { close(): void } | null = null;
  const stopWaiting = () => {
    waiting?.close();
    waiting = null;
  };
  const waitForOnline = () => {
    stopWaiting();
    const create = options.entry?.createStream ?? createRemoteStream;
    waiting = create({
      issuer,
      ticket: async () => (await client.me.streamTicket({})).ticket,
      onEvent(event) {
        if (event.type === "sourceOnline" && event.sourceId === hostId) {
          stopWaiting();
          void open();
        }
      },
    });
  };
  let retryTimer: unknown = null;

  /* ------------------------------ 认领 ------------------------------- */

  let claimedByOther = false;
  const claim = async (at: string) => {
    if (channel === null || readRecord(storage, at) === undefined) return;
    claimedByOther = false;
    channel.postMessage({ type: "claim", key: at, tabId });
    await new Promise<void>((resolve) => later(resolve, CLAIM_WAIT_MS));
    // 别的标签页拿着同一把刷新令牌（复制出来的标签页）：这份让给它，本页重登。
    if (claimedByOther) writeRecord(storage, at, null);
  };

  /** 经当前路由 `session/logout`，最多等 `ms`（标签页冻结、通道挂住时不卡住）。 */
  const logoutWithin = (ms: number): Promise<void> =>
    Promise.race([
      identity.logout().catch(() => undefined),
      new Promise<void>((resolve) => later(resolve, ms)),
    ]);

  /** 被登出（本页或别处）：尽力吊销主机侧会话，清本条，盖上「已登出」。 */
  let signingOut: Promise<void> | null = null;
  const signedOut = (): Promise<void> => {
    if (view.kind === "signedOut") return Promise.resolve();
    signingOut ??= (async () => {
      closed = true;
      stopWaiting();
      if (view.kind === "entered" || view.kind === "expired")
        await identity.logout().catch(() => undefined);
      sessions.clear();
      provider.clear();
      entry.signOut();
      setView({ kind: "signedOut" });
    })().finally(() => {
      signingOut = null;
    });
    return signingOut;
  };

  channel?.addEventListener("message", ({ data }) => {
    if (disposed || !isCloudSessionMessage(data)) return;
    if (data.type === "signingOut") {
      if (view.kind !== "entered" && view.kind !== "expired") return;
      channel.postMessage({ type: "loggingOut", tabId });
      void signedOut().finally(() =>
        channel.postMessage({ type: "loggedOut", tabId }),
      );
    } else if (data.type === "signedOut") {
      void signedOut();
    } else if (data.type === "loggingOut" || data.type === "loggedOut") {
      return;
    } else if (data.type === "accountChanged") {
      if (accountId !== null && data.accountId !== accountId) void signedOut();
    } else if (data.type === "claim") {
      if (
        data.tabId !== tabId &&
        data.key === key() &&
        (view.kind === "entered" || live !== undefined)
      )
        channel.postMessage({
          type: "claimed",
          key: data.key,
          tabId: data.tabId,
        });
    } else if (data.tabId === tabId && data.key === key()) {
      claimedByOther = true;
    }
  });

  const fail = (code: string) =>
    setView({
      kind: "failed",
      code: KNOWN_FAILURES.has(code) ? code : HOST_FAILURE.failed,
    });

  async function open(): Promise<void> {
    if (disposed) return;
    if (retryTimer !== null) cancel(retryTimer);
    retryTimer = null;
    closed = false;
    setView({ kind: "connecting" });
    let me: Awaited<ReturnType<CloudClient["me"]["get"]>>;
    try {
      me = await client.me.get({});
    } catch (error) {
      if (statusOf(error) === 401) setView({ kind: "login" });
      else fail(codeOf(error));
      return;
    }
    // 同一个标签页里换了账号：上一位的主机侧会话先经还装着的路由吊销（限时），再丢它的记录。
    if (accountId !== null && accountId !== me.accountId) {
      if (wasEntered) await logoutWithin(LOGOUT_TIMEOUT_MS);
      sessions.clear();
      provider.clear();
    }
    // 再次进入：先卸下上一次的路由。
    if (wasEntered) {
      entry.close();
      wasEntered = false;
    }
    accountId = me.accountId;
    clearHostSessions(storage, (stored) =>
      stored.startsWith(`${HOST_KEY_PREFIX}${me.accountId}.`),
    );
    try {
      detail = await client.sources.get({ sourceId: hostId });
    } catch (error) {
      if (statusOf(error) === 401) setView({ kind: "login" });
      else fail(codeOf(error) || HOST_FAILURE.failed);
      return;
    }
    const space = detail.space;
    const team =
      space?.kind === "team"
        ? me.teams?.find((one) => one.teamId === space.teamId)
        : undefined;
    info = {
      name: detail.name,
      space: detail.space?.kind === "team" ? "team" : "personal",
      owner: detail.owner,
      consoleHref:
        team === undefined
          ? `/me/hosts/${encodeURIComponent(hostId)}`
          : `/t/${encodeURIComponent(team.slug)}/hosts/${encodeURIComponent(hostId)}`,
    };
    setApprovalHint(hostId, info.space);
    if (!detail.online) {
      setView({ kind: "offline", lastSeenAtMs: detail.lastSeenAtMs });
      waitForOnline();
      return;
    }
    await claim(key()!);
    principalChanged = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await entry.enter({ sourceId: hostId, name: detail.name });
        wasEntered = true;
        stopWaiting();
        setView({ kind: "entered" });
        return;
      } catch (error) {
        const code = codeOf(error);
        // 主体不符：记录已丢，重新 cloud/login 一次。
        if (principalChanged && attempt === 0) {
          principalChanged = false;
          continue;
        }
        if (code === SOURCE_ERROR.offline) {
          setView({ kind: "offline", lastSeenAtMs: detail.lastSeenAtMs });
          waitForOnline();
          return;
        }
        if (code === "rate_limited") {
          setView({ kind: "connecting", rateLimited: true });
          retryTimer = later(() => void open(), RATE_LIMIT_RETRY_MS);
          return;
        }
        if (code === SOURCE_ERROR.unauthorized) {
          sessions.clear();
          fail(HOST_FAILURE.failed);
          return;
        }
        fail(code === SOURCE_ERROR.unreachable ? HOST_FAILURE.failed : code);
        return;
      }
    }
  }

  const host: ConsoleHost = {
    hostId,
    issuer,
    get view() {
      return view;
    },
    get status() {
      return entry.status;
    },
    get info() {
      return info;
    },
    get ownerMismatch() {
      return ownerMismatch;
    },
    subscribe(listener) {
      listeners.add(listener);
      const stop = entry.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    open,
    async signOut() {
      await signedOut();
    },
    guest: () => null,
    dispose() {
      disposed = true;
      stopWaiting();
      if (retryTimer !== null) cancel(retryTimer);
      scheduler.dispose();
      entry.close();
      channel?.close?.();
    },
  };
  return host;
}

/* ------------------------------- 页面那一个 ------------------------------- */

let active: ConsoleHost | null = null;

/** `/h/` 页面上的那一个（入口建，`HostRoot` 读）；别的页面是 `null`。 */
export function consoleHost(): ConsoleHost | null {
  return active;
}

export function startConsoleHost(options: ConsoleHostOptions): ConsoleHost {
  active?.dispose();
  active = createConsoleHost(options);
  setRelayedPage(active);
  return active;
}
