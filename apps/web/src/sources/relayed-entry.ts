import {
  type HostedSessionStore,
  restoreHostedCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import type { CloudOptions, CloudSource } from "./cloud-client";
import type { ManagedSocketState } from "./managed-socket";
import { type SiblingMount, mountSiblingSources } from "./mounts";
import { sourceRegistry } from "./registry";
import type { RelaySession } from "./relay-access";
import {
  type RemoteStream,
  type StreamTarget,
  applyMeStreamEvent,
  createRemoteStream,
  resyncTargets,
} from "./remote-stream";
import { type EnteredRoute, enterRoute } from "./route-entry";
import {
  type CloudAuth,
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceDescriptor,
  SourceError,
  type SourceFailure,
  type SourceState,
} from "./types";

/**
 * 经中继把一台主机装成页面的本机源（从 `hosted.ts` 抽出，与会话来源无关）：
 * 状态机（含「中继停了」）、`me.stream` 落到当前主机的目标、流重开后的对账、
 * 以及 `enter` 时的 {@link HostedSessionStore}。
 *
 * 会话来源各自提供的只有三件事：怎样要断言（`provider`，背后是
 * `relay-access.ts`）、怎样换 `me.stream` 的票（`streamAuth` / `createStream`）、
 * 怎样列目录（`listSources`）。个人中转托管页（`hosted.ts`，Bearer）与控制台
 * `/h/`（Cookie）共用这一份。
 */

export interface RelayedStatus {
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

/** 源 core 会话存在哪（按源）；`clear` 丢掉这个来源记下的全部。 */
export interface RelayedSessions {
  load(sourceId: string): Promise<RelaySession | undefined>;
  save(sourceId: string, session: RelaySession): void;
  clear(): void;
}

export interface RelayedEntryOptions {
  readonly issuer: string;
  readonly provider: CredentialProvider;
  /** 换 `me.stream` 票用的云端凭据。 */
  readonly streamAuth: CloudAuth;
  /** 列这个账号可见的主机（流重开后对账用）。 */
  readonly listSources: () => Promise<readonly CloudSource[]>;
  /** 源 core 会话的保存处。 */
  readonly sessions: RelayedSessions;
  /** 一起挂进页面源表的其余主机（进主机那一刻读；缺省没有）。 */
  readonly directory?: () => readonly Pick<CloudSource, "sourceId" | "name">[];
  /** 进去了：记下这台主机（刷新后续上用）。 */
  readonly onEntered?: (source: Pick<CloudSource, "sourceId" | "name">) => void;
  /** 当前主机被撤销 / 访问被收回 / 凭据被拒（在状态落到 `unauthorized` 之前调）。 */
  readonly onRevoked?: (failure: SourceFailure) => void;
  readonly cloud?: CloudOptions;
  /** 造 `me.stream`（缺省 `remote-stream.ts`；换票方式不同的来源可换掉）。 */
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
}

export interface RelayedEntry {
  readonly status: RelayedStatus;
  subscribe(listener: () => void): () => void;
  /** 把这台主机装成页面的本机源；失败抛（状态先落到对应的失败态）。 */
  enter(source: Pick<CloudSource, "sourceId" | "name">): Promise<void>;
  /** 关流、卸下主机与其余主机、清掉记下的会话，状态回到 `idle`。 */
  dispose(): void;
}

/** 目录里的一台主机 → 经这个中继到达的源描述。 */
export function relayedDescriptor(
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

export function createRelayedEntry(options: RelayedEntryOptions): RelayedEntry {
  const { issuer, provider } = options;

  let status: RelayedStatus = {
    state: "idle",
    lastError: null,
    relayDown: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: RelayedStatus) => {
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
      // 主机回来了：隧道是新的，会话在 core 的库里还在。旧的端到端通道随旧隧道
      // 关了：先换一条新通道（重取断言、重开 /_relay/e2e），再叫醒在退避里的流，
      // 它们在新通道上重连。换不上也叫醒：流的换票会再试（单飞、有冷却）。
      const recovered = (await entered?.recover()) ?? true;
      if (recovered) setStatus("ready", null);
      wake();
    },
    revoke(failure) {
      provider.invalidate(current ?? "");
      options.onRevoked?.(failure);
      setStatus("unauthorized", failure);
    },
  };

  /** 流（重）新打开：对一次目录，补上断开期间错过的上下线。 */
  const resync = async () => {
    if (current === null) return;
    try {
      const listed = await options.listSources();
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
      auth: options.streamAuth,
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

  return {
    get status() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async enter(source) {
      const descriptor = relayedDescriptor(issuer, source);
      setStatus("connecting", null);
      const store: HostedSessionStore = {
        load: () => options.sessions.load(source.sourceId),
        save: (session) => options.sessions.save(source.sourceId, session),
        // 只在身份面登出时调：刷新之后不该再静默登回去。
        clear: () => {
          provider.invalidate(source.sourceId);
          options.sessions.clear();
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
      options.onEntered?.(source);
      setStatus("ready", null);
      siblings?.dispose();
      siblings = (options.mount ?? mountSiblingSources)({
        primary: descriptor,
        siblings: (options.directory?.() ?? []).map((row) =>
          relayedDescriptor(issuer, row),
        ),
        provider,
      });
      startStream();
    },
    dispose() {
      stream?.close();
      stream = null;
      stopRelayTimer();
      streamOpened = false;
      siblings?.dispose();
      siblings = null;
      entered?.dispose();
      entered = null;
      options.sessions.clear();
      if (current !== null) provider.invalidate(current);
      current = null;
      publish({ state: "idle", lastError: null, relayDown: false });
    },
  };
}
