import {
  IdentityRequestError,
  IdentityTransportError,
  pairIdentity,
  pairWithGateway,
  takePairingTicket,
} from "../api/identity";
import {
  type E2eChannels,
  e2eChannels,
  fingerprintPrefix,
  sealedJoinOptions,
} from "../sources/e2e/manager";
import {
  exchangePairingCode,
  pairingPakeFinish,
  pairingPakeStart,
} from "../api/gateway";
import { normalizeFingerprint } from "@armadra/shared";
import { runPairingPake } from "./pairing-pake";
import { saveRuntimeOrigin } from "../api/runtime-url";
import { parsePairingQr } from "../host/qr";
import { LOCAL_SOURCE_ID } from "../api/source";
import { openAfterJoin } from "../sources/join-intent";
import { forgetRecent, setEnterIntent } from "../services/recent";
import { isShareRole } from "../sources/origin";
import { helloHostName, routesOf } from "../sources/routing";
import { type SourceDescriptor, SourceError } from "../sources/types";
import {
  CloudChallengeRequired,
  CloudError,
  CloudTransportError,
  type CloudOptions,
  type CloudSession,
  type CloudSource,
  cloudAcceptLink,
  cloudAssertion,
  cloudLinkInfo,
  cloudLogin,
  cloudSources,
  coreCloudLogin,
  thisDevice,
} from "../sources/cloud-client";
import {
  type ConnectionOrigin,
  activeConnection,
  loadConnections,
  originOf,
  remoteSlotOf,
  removeConnection,
  setActiveConnection,
  setRemoteSlot,
  upsertConnection,
} from "./connections";
import { guestPrincipal, serviceIdOf } from "./credentials";
import type { ConnectFailure } from "./ConnectScreen";
import { issuerOrigin, parseJoinLink } from "./join-link";
import { nativeBridge, type NativeBridge } from "./native-bridge";

/** 配对失败 → 连接页的原因。认不出的一律 `failed`。 */
export function failureOf(error: unknown): ConnectFailure {
  if (error instanceof IdentityTransportError) return "unreachable";
  if (error instanceof IdentityRequestError) {
    // 配对码换票的几种拒绝（契约 §24）。
    if (error.code === "pairing_code_invalid") return "codeInvalid";
    if (error.code === "pairing_code_disabled") return "codeDisabled";
    if (error.code === "origin_mismatch") return "codeOrigin";
    if (error.status === 429) return "rateLimited";
  }
  if (
    error instanceof IdentityRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 410)
  )
    return "expired";
  return "failed";
}

export interface NativeConnectDeps {
  readonly bridge: NativeBridge;
  readonly pair: typeof pairWithGateway;
  readonly save: (origin: string) => void;
  /**
   * 记进连接表并设为当前（局域网配对也是一个连接，键是 core 的 `hostId`；
   * 同一个源之后经个人中转挂上来会合并成一行）。
   */
  readonly record?: (connection: {
    readonly sourceId: string;
    readonly origin: string;
    readonly fingerprint: string;
    /** 主机 hello 报的名字（契约 §61）；取不到不带。 */
    readonly hostName?: string;
  }) => void;
  /** 问主机 hello 的名字（配对成功之后、钉过信任锚）；不给就不问。 */
  readonly hostName?: (origin: string) => Promise<string>;
  /** 记下来源后重新加载：本机源的地址在一次加载里只算一次。 */
  readonly reload: () => void;
}

const nativeDeps = (): NativeConnectDeps => ({
  bridge: nativeBridge(),
  pair: pairWithGateway,
  save: saveRuntimeOrigin,
  record: recordDirectConnection,
  hostName: (origin) => helloHostName(origin),
  reload: () => globalThis.location.reload(),
});

/**
 * 刚加上（或点了）的连接：记为当前，并让重载后的入口直接进它——选择页是启动
 * 的缺省（A7-1），加完连接不该再停在列表上。
 */
function enterNext(sourceId: string): void {
  setActiveConnection(sourceId);
  setEnterIntent(sourceId);
}

export function recordDirectConnection(connection: {
  readonly sourceId: string;
  readonly origin: string;
  readonly fingerprint: string;
  readonly hostName?: string;
}): void {
  upsertConnection({
    sourceId: connection.sourceId,
    label: "",
    // 缺省名取主机报的「主机名称」；改过名的行不跟着变（§61）。
    ...(connection.hostName ? { defaultLabel: connection.hostName } : {}),
    baseUrl: connection.origin,
    relayOrigin: "",
    cloudIssuer: "",
    fingerprint: connection.fingerprint,
  });
  enterNext(connection.sourceId);
}

/** 配对答案里的源标识（core 的 `hostId`）；没有就不记连接表。 */
function hostIdOf(session: unknown): string {
  const hostId = (session as { hostId?: unknown } | null)?.hostId;
  return typeof hostId === "string" ? hostId : "";
}

/**
 * 原生 App：配对链接（网页链接或 `armadra://pair` 深链，契约 §17.3）→ 先把
 * 信任锚指纹交给原生钉扎 → 用票配对（凭据进钥匙串）→ 记下来源 → 重载。
 *
 * 指纹必须有：App 不装 CA，没有指纹就没有东西可钉，宁可不连。
 */
export async function connectNative(
  link: string,
  deps: NativeConnectDeps = nativeDeps(),
): Promise<ConnectFailure | null> {
  const scanned = parsePairingQr(link);
  if (scanned === null) return "invalid";
  if (scanned.fingerprint === "") return "noFingerprint";
  try {
    await deps.bridge.pin(scanned.origin, scanned.fingerprint);
  } catch {
    return "pin";
  }
  let session: unknown;
  try {
    session = await deps.pair(scanned.origin, scanned.ticket);
  } catch (error) {
    return failureOf(error);
  }
  const sourceId = hostIdOf(session);
  if (deps.record !== undefined && sourceId !== "") {
    const hostName = (await deps.hostName?.(scanned.origin)) ?? "";
    deps.record({
      sourceId,
      origin: scanned.origin,
      fingerprint: scanned.fingerprint,
      ...(hostName ? { hostName } : {}),
    });
  }
  deps.save(scanned.origin);
  deps.reload();
  return null;
}

/**
 * 手机浏览器：页面就是经这个 Gateway 打开的，票从 `#pair=` 来，这时才取走并
 * 从地址栏抹掉。会话是 Cookie，配对成功就能进画布。
 */
export async function connectWeb(
  ticket: string = takePairingTicket(),
  pair: typeof pairIdentity = pairIdentity,
): Promise<ConnectFailure | null> {
  if (ticket === "") return "expired";
  try {
    await pair(ticket);
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * 配对码（契约 §24）：8 位换出一张与 `#pair=` 相同的票，再照常配对。
 *
 *  - 手机浏览器：页面就是经这个 Gateway 打开的，会话是 Cookie。
 *  - 原生 App：只在已经记下（并钉过）一个 Gateway 来源时可用——App 不装 CA，
 *    没钉过信任锚就连不上，拿不到码换出来的指纹。换出的指纹照样再钉一次，
 *    锚变了（重置 CA）这一步就失败，不自动信任新证书。
 */
export async function connectWithCode(
  code: string,
  target:
    | { readonly mode: "web" }
    | { readonly mode: "native"; readonly origin: string },
  deps: {
    readonly exchange?: typeof exchangePairingCode;
    readonly pairWeb?: typeof pairIdentity;
    readonly native?: NativeConnectDeps;
  } = {},
): Promise<ConnectFailure | null> {
  const exchange = deps.exchange ?? exchangePairingCode;
  let payload: Awaited<ReturnType<typeof exchangePairingCode>>;
  try {
    payload =
      target.mode === "web"
        ? await exchange(code)
        : await exchange(code, target.origin);
  } catch (error) {
    return failureOf(error);
  }
  if (target.mode === "web") {
    try {
      await (deps.pairWeb ?? pairIdentity)(payload.ticket);
      return null;
    } catch (error) {
      return failureOf(error);
    }
  }
  const native = deps.native ?? nativeDeps();
  if (payload.origin !== target.origin) return "failed";
  return pairNativePayload(payload, native);
}

/**
 * 拿到配对载荷之后的那一段（扫码、换码、PAKE 都一样）：按载荷的指纹钉锚 →
 * 用票配对 → 记连接 → 记下来源 → 重载。锚变了（重置 CA）钉扎这一步就失败，
 * 不自动信任新证书。
 */
async function pairNativePayload(
  payload: {
    readonly origin: string;
    readonly ticket: string;
    readonly fingerprint: string;
  },
  native: NativeConnectDeps,
): Promise<ConnectFailure | null> {
  try {
    await native.bridge.pin(payload.origin, payload.fingerprint);
  } catch {
    return "pin";
  }
  let session: unknown;
  try {
    session = await native.pair(payload.origin, payload.ticket);
  } catch (error) {
    return failureOf(error);
  }
  const sourceId = hostIdOf(session);
  if (native.record !== undefined && sourceId !== "") {
    const hostName = (await native.hostName?.(payload.origin)) ?? "";
    native.record({
      sourceId,
      origin: payload.origin,
      fingerprint: payload.fingerprint,
      ...(hostName ? { hostName } : {}),
    });
  }
  native.save(payload.origin);
  native.reload();
  return null;
}

/** 连接表里发往这个来源的直连那一行钉的指纹；没有是 `null`。 */
function recordedFingerprint(origin: string): string | null {
  const row = loadConnections().find(
    (connection) => connection.baseUrl === origin && connection.fingerprint,
  );
  return row?.fingerprint ?? null;
}

export interface NativeCodeDeps {
  readonly native?: NativeConnectDeps;
  readonly exchange?: typeof exchangePairingCode;
  readonly start?: typeof pairingPakeStart;
  readonly finish?: typeof pairingPakeFinish;
  /** 这个来源在连接表里钉过的指纹（缺省读连接表）。 */
  readonly recorded?: (origin: string) => string | null;
}

/**
 * 原生 App 用配对码连接（契约 §24、§73）：人输配对卡上的地址与 8 位码。
 *
 *  - 这个来源已经钉过、服务端仍发着那张锚：照旧 `exchange`（§24）。
 *  - 还没钉过（首次连接）：`peek` 取到的指纹 F′ 不能直接信——可能是中间人的。
 *    连接表里这个来源钉的若不是 F′，直接拒绝，不覆盖原有钉扎（证书轮换要扫码）；
 *    否则暂钉 F′（之后的请求只认这张证书），再用配对码跑 PAKE：Gateway 的确认
 *    标签证明它知道这枚码、发的就是 F′，对上了才换票。对不上不发任何东西。
 *
 * 核对失败时暂钉的 F′ 撤不掉（原生插件没有撤销钉扎），但这个来源上没有会话
 * 也没有连接记录，下一次扫码或配对会改钉。
 */
export async function connectNativeWithCode(
  address: string,
  code: string,
  deps: NativeCodeDeps = {},
): Promise<ConnectFailure | null> {
  const origin = issuerOrigin(address);
  if (origin === null || !origin.startsWith("https:")) return "address";
  const native = deps.native ?? nativeDeps();
  const peeked = await native.bridge.peek(origin).catch(() => null);
  if (peeked === null) return "unreachable";
  if (peeked.pinned) {
    return connectWithCode(
      code,
      { mode: "native", origin },
      {
        native,
        ...(deps.exchange ? { exchange: deps.exchange } : {}),
      },
    );
  }
  const recorded = (deps.recorded ?? recordedFingerprint)(origin);
  if (
    recorded !== null &&
    normalizeFingerprint(recorded) !== normalizeFingerprint(peeked.fingerprint)
  )
    return "anchorChanged";
  try {
    await native.bridge.pin(origin, peeked.fingerprint);
  } catch {
    return "pin";
  }
  const start = deps.start ?? pairingPakeStart;
  const finish = deps.finish ?? pairingPakeFinish;
  let outcome: Awaited<ReturnType<typeof runPairingPake>>;
  try {
    outcome = await runPairingPake({
      code,
      origin,
      fingerprint: peeked.fingerprint,
      transport: {
        start: async (body) => {
          try {
            return await start(origin, body);
          } catch (error) {
            // 旧版 core 没有这条路由：404 而不是配对码的拒绝。
            if (error instanceof IdentityRequestError && error.status === 404)
              throw new PakeUnsupported();
            throw error;
          }
        },
        finish: (body) => finish(origin, body),
      },
    });
  } catch (error) {
    if (error instanceof PakeUnsupported) return "codeUpgrade";
    return failureOf(error);
  }
  if (outcome.kind === "mismatch") return "codeMismatch";
  const payload = outcome.payload;
  // 标签已经证明了来源与锚；载荷再对不上就是 Gateway 自己不一致，不信。
  if (
    payload.origin !== origin ||
    normalizeFingerprint(payload.fingerprint) !==
      normalizeFingerprint(peeked.fingerprint)
  )
    return "codeMismatch";
  return pairNativePayload(payload, native);
}

class PakeUnsupported extends Error {}

/* ------------------------------- 个人中转 ------------------------------- */

/** 远程服务那几步的失败 → 连接页的原因。 */
export function cloudFailureOf(error: unknown): ConnectFailure {
  if (error instanceof CloudTransportError) return "unreachable";
  if (error instanceof CloudError) {
    switch (error.code) {
      case "credentials_invalid":
        return "credentials";
      case "account_locked":
        return "locked";
      case "rate_limited":
        return "rateLimited";
      case "challenge_invalid":
      case "challenge_required":
        return "challengeInvalid";
      case "link_invalid":
        return "linkInvalid";
      case "link_expired":
        return "linkExpired";
      case "link_exhausted":
        return "linkExhausted";
      case "link_secret_invalid":
        return "linkSecret";
      case "invitation_invalid":
        return "invitation";
      case "source_offline":
        return "offline";
      default:
        return "failed";
    }
  }
  if (error instanceof SourceError && error.code === "source_offline")
    return "offline";
  return failureOf(error);
}

/** 能挂的源：连接页列成勾选项。 */
export interface RelaySourceChoice {
  readonly sourceId: string;
  readonly name: string;
  readonly online: boolean;
}

/** 个人中转那几步的结果；界面按 `kind` 切到下一步。 */
export type RelayOutcome =
  | { readonly kind: "fingerprint"; readonly fingerprint: string }
  | { readonly kind: "sources"; readonly sources: readonly RelaySourceChoice[] }
  | { readonly kind: "done" }
  /**
   * 远程服务要求人机验证（契约 §62）：界面升起挑战面板，拿到令牌再 `begin` 一次
   * （入参加 `challengeToken`）。
   */
  | { readonly kind: "challenge"; readonly siteKey: string }
  | { readonly kind: "failure"; readonly failure: ConnectFailure };

const failed = (failure: ConnectFailure): RelayOutcome => ({
  kind: "failure",
  failure,
});

export interface RelayDeps {
  readonly bridge: NativeBridge;
  readonly cloud?: CloudOptions;
  /** 端到端通道（契约 §78、§80）；不给不开（测试）。 */
  readonly e2e?: E2eChannels;
  /** 挂好之后重新加载：本机源的地址在一次加载里只算一次。 */
  readonly reload: () => void;
}

/** 个人中转的添加：地址 + 账号 + 口令，或一枚分享链接。 */
export interface RelayEnrollment {
  /** 账号登录：先核对信任锚指纹（需要时），再登录、列出能挂的源。 */
  begin(input: {
    readonly issuer: string;
    readonly account: string;
    readonly password: string;
    /** 挑战面板交回的一次性令牌（契约 §62）。 */
    readonly challengeToken?: string;
  }): Promise<RelayOutcome>;
  /** 分享链接 / 二维码：直接挂载（指纹见过的不再问）。 */
  join(link: string): Promise<RelayOutcome>;
  /** 人确认了指纹：钉住，接着刚才的步骤。 */
  trust(): Promise<RelayOutcome>;
  /** 勾选的源逐个挂载。 */
  mount(sourceIds: readonly string[]): Promise<RelayOutcome>;
  /** 放弃：口令与会话不再留在内存里。 */
  reset(): void;
}

/**
 * 一次添加的状态机。口令只在 `begin` 到登录完成之间留在内存里，云会话（访问令牌
 * 与刷新令牌）只到 `mount` 为止；之后凭据只在钥匙串里。
 */
export function createRelayEnrollment(
  deps: RelayDeps = {
    bridge: nativeBridge(),
    reload: () => globalThis.location.reload(),
    e2e: e2eChannels(() => thisDevice().name),
  },
): RelayEnrollment {
  let issuer = "";
  let fingerprint = "";
  let resume: (() => Promise<RelayOutcome>) | null = null;
  let session: CloudSession | null = null;
  let choices: readonly CloudSource[] = [];

  const reset = () => {
    issuer = "";
    fingerprint = "";
    resume = null;
    session = null;
    choices = [];
  };

  /**
   * 钉扎在登录之前：自签的中继在钉住之前连 TLS 都过不了。系统本来就信的（ACME）
   * 与已经钉过同一枚的直接过；其余要人核对指纹。网页里没有原生的 TLS 钉扎，
   * 交给浏览器。
   */
  const gate = async (
    origin: string,
    next: () => Promise<RelayOutcome>,
  ): Promise<RelayOutcome> => {
    issuer = origin;
    if (!deps.bridge.available || !origin.startsWith("https:")) return next();
    const peeked = await deps.bridge.peek(origin);
    if (peeked === null) return failed("unreachable");
    if (peeked.trusted || peeked.pinned) {
      fingerprint = peeked.pinned ? peeked.fingerprint : "";
      return next();
    }
    fingerprint = peeked.fingerprint;
    resume = next;
    return { kind: "fingerprint", fingerprint: peeked.fingerprint };
  };

  const signIn = async (
    account: string,
    password: string,
    challengeToken?: string,
  ): Promise<RelayOutcome> => {
    try {
      session = await cloudLogin(
        issuer,
        account,
        password,
        thisDevice(),
        deps.cloud,
        challengeToken,
      );
      choices = await cloudSources(issuer, session.accessToken, deps.cloud);
    } catch (error) {
      session = null;
      if (error instanceof CloudChallengeRequired)
        return { kind: "challenge", siteKey: error.challenge.siteKey };
      return failed(cloudFailureOf(error));
    }
    if (choices.length === 0) return failed("noSources");
    return {
      kind: "sources",
      sources: choices.map(({ sourceId, name, online }) => ({
        sourceId,
        name,
        online,
      })),
    };
  };

  /**
   * 远程服务的登录进钥匙串的这一槽：主人按账号、访客按它加入的源各一份
   * （`credentials.ts::serviceIdOf`），访客加入不顶替主人。
   */
  const remember = async (
    refreshToken: string | undefined,
    serviceId: string,
  ) => {
    if (refreshToken === undefined) throw new CloudError(502, "bad_response");
    await deps.bridge.setRemote({
      serviceId,
      issuer,
      kind: "personal",
      refreshToken,
      fingerprint,
    });
  };

  // 名字是目录里那台主机登记的「主机名称」：作缺省名，改过名的行不跟着变（§61）。
  const connectionOf = (
    sourceId: string,
    name: string,
    slot: string,
    origin: ConnectionOrigin = "mine",
    share: {
      readonly role?: string;
      readonly expiresAtMs?: number;
      /** 分享经由的团队（契约 §86）；按链接加入时总会带，个人分享是空串。 */
      readonly teamId?: string;
      readonly teamName?: string;
    } = {},
  ) => {
    upsertConnection({
      sourceId,
      label: "",
      origin,
      ...(isShareRole(share.role) ? { shareRole: share.role } : {}),
      ...(share.expiresAtMs ? { shareExpiresAtMs: share.expiresAtMs } : {}),
      ...(share.teamId === undefined
        ? {}
        : { teamId: share.teamId, teamName: share.teamName ?? "" }),
      ...(name ? { defaultLabel: name } : {}),
      baseUrl: "",
      relayOrigin: issuer,
      cloudIssuer: issuer,
      fingerprint: "",
    });
    // 槽按 `(源, 这条中继)`：同一台主机经另一个中继挂上时不顶替这一份（§55）。
    setRemoteSlot(sourceId, slot, issuer);
  };

  return {
    reset,
    async begin(input) {
      const origin = issuerOrigin(input.issuer);
      if (origin === null) return failed("address");
      const { account, password, challengeToken } = input;
      return gate(origin, () => signIn(account, password, challengeToken));
    },
    async join(link) {
      const parsed = parseJoinLink(link);
      if (parsed === null) return failed("invalid");
      return gate(parsed.issuer, async () => {
        try {
          const device = thisDevice();
          // 权限与到期只为连接页上那一行的标注：取不到不影响加入。
          const info = await cloudLinkInfo(
            issuer,
            parsed.linkId,
            deps.cloud,
          ).catch(() => null);
          const accepted = await cloudAcceptLink(
            issuer,
            parsed.linkId,
            parsed.secret,
            device,
            deps.cloud,
          );
          const login = await coreCloudLogin(
            accepted.relayBaseUrl,
            accepted.relayToken,
            accepted.assertion,
            parsed.invitationToken,
            await sealedJoinOptions(deps.e2e, deps.cloud, {
              issuer,
              sourceId: accepted.sourceId,
              base: accepted.relayBaseUrl,
              relayToken: accepted.relayToken,
              invitationToken: parsed.invitationToken,
              ...(fingerprintPrefix(parsed.identityFp, accepted.identityFp) ===
              undefined
                ? {}
                : {
                    fingerprintPrefix: fingerprintPrefix(
                      parsed.identityFp,
                      accepted.identityFp,
                    )!,
                  }),
            }),
          );
          const slot = serviceIdOf(issuer, guestPrincipal(accepted.sourceId));
          await remember(accepted.guestSession.refreshToken, slot);
          await deps.bridge.setSession({
            sourceId: accepted.sourceId,
            origin: issuer,
            via: "relayed",
            accessToken: login.native.accessToken,
            refreshToken: login.native.refreshToken,
            expiresAtMs: login.expiresAtUnixMs,
          });
          // 名字是锦上添花：目录取不到就用空标签，界面按地址兜底。
          const name = await cloudSources(
            issuer,
            accepted.guestSession.accessToken,
            deps.cloud,
          )
            .then(
              (list) =>
                list.find((item) => item.sourceId === accepted.sourceId)
                  ?.name ?? "",
            )
            .catch(() => "");
          connectionOf(accepted.sourceId, name, slot, "shared", {
            ...(info?.role ? { role: info.role } : {}),
            ...(info?.expiresAtMs ? { expiresAtMs: info.expiresAtMs } : {}),
            teamId: login.team?.teamId ?? "",
            teamName: login.team?.name ?? "",
          });
          // 加入的主机不顶替这个页面的主连接：有自己的电脑就仍以它为主，加入的
          // 作为同伴挂上、直接打开它的工作空间；一台自己的都没有时它只好当主连接。
          const own = ownPrimary(accepted.sourceId);
          if (own === null) {
            enterNext(accepted.sourceId);
            openAfterJoin(LOCAL_SOURCE_ID);
          } else {
            enterNext(own);
            openAfterJoin(accepted.sourceId);
          }
        } catch (error) {
          return failed(cloudFailureOf(error));
        }
        reset();
        deps.reload();
        return { kind: "done" };
      });
    },
    async trust() {
      const next = resume;
      if (next === null || !/^[0-9a-f]{64}$/.test(fingerprint))
        return failed("failed");
      try {
        await deps.bridge.pin(issuer, fingerprint);
      } catch {
        // 钉的时候对端出示的不是人刚核对过的那一张。
        return failed("fingerprint");
      }
      resume = null;
      return next();
    },
    async mount(sourceIds) {
      const current = session;
      if (current === null) return failed("failed");
      const device = thisDevice();
      // 主人这一槽按账号；远程服务没答账号时用固定的 `owner`（仍与访客分开）。
      const slot = serviceIdOf(issuer, current.account?.accountId || "owner");
      let mounted: string | null = null;
      let failure: ConnectFailure = "offline";
      for (const sourceId of sourceIds) {
        const choice = choices.find((item) => item.sourceId === sourceId);
        if (choice === undefined) continue;
        try {
          const assertion = await cloudAssertion(
            issuer,
            current.accessToken,
            sourceId,
            device,
            deps.cloud,
          );
          if (!assertion.online) continue;
          const login = await coreCloudLogin(
            assertion.relayBaseUrl,
            assertion.relayToken,
            assertion.assertion,
            undefined,
            deps.cloud,
          );
          await deps.bridge.setSession({
            sourceId,
            origin: issuer,
            via: "relayed",
            accessToken: login.native.accessToken,
            refreshToken: login.native.refreshToken,
            expiresAtMs: login.expiresAtUnixMs,
          });
          connectionOf(sourceId, choice.name, slot);
          mounted ??= sourceId;
        } catch (error) {
          failure = cloudFailureOf(error);
        }
      }
      if (mounted === null) return failed(failure);
      try {
        await remember(current.refreshToken, slot);
      } catch (error) {
        return failed(cloudFailureOf(error));
      }
      enterNext(mounted);
      reset();
      deps.reload();
      return { kind: "done" };
    },
  };
}

/** 页面的主连接：当前连接若是自己的电脑就是它，否则表里第一台自己的；没有是 `null`。 */
function ownPrimary(except: string): string | null {
  const active = activeConnection();
  if (
    active !== null &&
    active.sourceId !== except &&
    originOf(active) === "mine"
  )
    return active.sourceId;
  return (
    loadConnections().find(
      (row) => row.sourceId !== except && originOf(row) === "mine",
    )?.sourceId ?? null
  );
}

/** 点一个连接：记为当前并重新加载（本机源的地址在一次加载里只算一次）。 */
export function openConnection(
  sourceId: string,
  reload: () => void = () => globalThis.location.reload(),
): void {
  enterNext(sourceId);
  reload();
}

/**
 * 移除一个连接：它的会话从钥匙串删掉；它用的那一槽远程服务登录没有别的连接
 * 在用了才一并删。其余连接与它们的凭据（同一中继下别的主体的槽）不动。
 */
export async function forgetConnection(
  sourceId: string,
  bridge: NativeBridge = nativeBridge(),
): Promise<void> {
  // 一个连接的每条中继各用一槽（§55）；删完连接，没有别的连接还在用的槽才删。
  const slotsOf = (item: SourceDescriptor) =>
    routesOf(item)
      .filter((route) => route.via === "relayed" && route.cloudIssuer !== "")
      .map(
        (route) =>
          remoteSlotOf(item.sourceId, route.origin) ??
          serviceIdOf(route.cloudIssuer),
      );
  const row = loadConnections().find((item) => item.sourceId === sourceId);
  const slots = row === undefined ? [] : [...new Set(slotsOf(row))];
  await bridge.removeSession(sourceId);
  removeConnection(sourceId);
  forgetRecent(sourceId);
  if (slots.length === 0) return;
  const stillUsed = new Set(loadConnections().flatMap(slotsOf));
  for (const slot of slots)
    if (!stillUsed.has(slot)) await bridge.removeRemote(slot);
}
