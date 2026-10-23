/**
 * Armadra 云（SaaS）的设备码登录、可登记的空间与登记本机（契约 §33.11）。
 *
 * 和个人中转的口令登录不同：加入时只拿一个 8 位设备码，人在浏览器里批准，批准后
 * 会话才存进 SecretStore。`deviceCode` 是只给发起设备的秘密，只留在这里的内存，
 * 不进答案、日志与库；注册令牌同样只在一次 `register` 调用里转一圈。
 */

import type { RemoteService } from "@armadra/shared";

import { CoreFailure, fail } from "../http/errors";
import { normalizeOrigin } from "./http-client";
import type {
  CloudSession,
  CloudSpace,
  RemoteClient,
  RemoteEndpoint,
  SpaceRef,
} from "./remote-client";
import { checkLabel, clip, naming } from "./rows";
import type { SourceSecrets } from "./secrets";
import type { CloudRegistrations } from "./service";
import type { RemoteRow, SourcesStore } from "./store";

/** 设备码轮询的最短间隔：服务端没给或给得太小时用。 */
const MIN_POLL_MS = 2_000;

/** 一次进行中的设备码登录。 */
interface PendingDevice {
  readonly deviceCode: string;
  readonly expiresAtMs: number;
  readonly intervalMs: number;
  /** 上次真正问服务端的时刻；间隔没到不重复问（页面轮询过快时 core 兜底）。 */
  polledAtMs: number;
}

/** 这个类向 `SourcesService` 借用的几样东西。 */
export interface CloudSignInHost {
  readonly store: SourcesStore;
  readonly secrets: SourceSecrets;
  readonly remote: RemoteClient;
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  readonly cloud?: (() => CloudRegistrations | undefined) | undefined;
  now(): number;
  newId(): string;
  remoteRow(serviceId: string): RemoteRow;
  remoteJson(row: RemoteRow): Promise<RemoteService>;
  endpoint(row: RemoteRow): RemoteEndpoint;
  remoteAccess(row: RemoteRow): Promise<{ accessToken: string }>;
  remember(serviceId: string, session: CloudSession): unknown;
  setCapabilities(serviceId: string, capabilities: readonly string[]): void;
  serial<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export class CloudSignIn {
  /** 进行中的设备码登录，按 `serviceId`。 */
  private readonly devices = new Map<string, PendingDevice>();

  constructor(private readonly host: CloudSignInHost) {}

  /**
   * 第一步：握手确认对端是 SaaS，`auth.deviceStart` 取设备码，记下一行 `kind = saas`
   * （还没有凭据）。同一个 `issuer` 再加是重新登录，不多一行。
   */
  async start(input: { issuer: string; label?: string | undefined }) {
    const { host } = this;
    const issuer = normalizeOrigin(input.issuer);
    const label = checkLabel(input.label);
    const existing = host.store.remoteByIssuer(issuer);
    if (existing !== undefined && existing.kind !== "saas") {
      throw fail("conflict", "这个地址已经是个人中转");
    }
    const endpoint: RemoteEndpoint = {
      issuer,
      fingerprint: existing?.fingerprint ?? "",
    };
    const info = await host.remote.info(endpoint);
    if (info.mode !== "saas") {
      throw fail("bad_request", "这个地址不是 Armadra 云");
    }
    const begun = await host.remote.deviceStart(endpoint);
    const intervalMs = Math.max(begun.intervalMs, MIN_POLL_MS);
    const row = host.store.upsertRemote({
      serviceId: existing?.serviceId ?? host.newId(),
      kind: "saas",
      issuer,
      ...naming(existing, label, info.name, new URL(issuer).host),
      accountHint: existing?.accountHint ?? "",
      fingerprint: endpoint.fingerprint,
      addedAtMs: existing?.addedAtMs ?? host.now(),
      lastOkAtMs: existing?.lastOkAtMs ?? 0,
    });
    host.setCapabilities(row.serviceId, info.capabilities);
    this.devices.set(row.serviceId, {
      deviceCode: begun.deviceCode,
      expiresAtMs: begun.expiresAtMs,
      intervalMs,
      polledAtMs: 0,
    });
    host.log.info("started a device-code sign-in", {
      serviceId: row.serviceId,
    });
    return {
      remote: await host.remoteJson(row),
      next: {
        deviceCode: {
          userCode: begun.userCode,
          verificationUrl: begun.verificationUrl,
          expiresAtMs: begun.expiresAtMs,
          intervalMs,
        },
      },
    };
  }

  /**
   * 轮询：`pending` 继续等；批准后把会话存进 SecretStore 答 `ready`；`denied` /
   * `expired` 终结这一次。间隔没到不重复问服务端（答 `pending`），服务端限流照
   * `rate_limited` + `retryAfterMs` 交给页面退避。个人中转加入即就绪。
   */
  async poll(
    serviceId: string,
  ): Promise<{ status: "pending" | "ready" | "denied" | "expired" }> {
    const { host } = this;
    const row = host.remoteRow(serviceId);
    if (row.kind !== "saas") return { status: "ready" };
    const pending = this.devices.get(serviceId);
    if (pending === undefined) {
      // 没有进行中的登录：已有凭据就是登好了；core 重启过、码丢了则需要重来。
      const saved = await host.secrets.remote(serviceId);
      return { status: saved === undefined ? "expired" : "ready" };
    }
    const at = host.now();
    if (at >= pending.expiresAtMs) {
      this.devices.delete(serviceId);
      return { status: "expired" };
    }
    if (
      pending.polledAtMs !== 0 &&
      at - pending.polledAtMs < pending.intervalMs
    ) {
      return { status: "pending" };
    }
    pending.polledAtMs = at;
    const answer = await host.remote.devicePoll(
      host.endpoint(row),
      pending.deviceCode,
    );
    if (answer.status === "pending") return { status: "pending" };
    this.devices.delete(serviceId);
    if (answer.status !== "approved") return { status: answer.status };
    await host.serial(`remote ${serviceId}`, async () => {
      await host.secrets.putRemote(serviceId, {
        refreshToken: answer.session.refreshToken,
        deviceId: answer.session.deviceId,
      });
      host.remember(serviceId, answer.session);
      host.store.upsertRemote({
        ...row,
        accountHint: clip(
          answer.session.email || answer.session.displayName,
          256,
        ),
        lastOkAtMs: host.now(),
      });
    });
    host.log.info("signed in to a remote service", { serviceId });
    return { status: "ready" };
  }

  /** 删远程服务时丢掉进行中的设备码。 */
  forget(serviceId: string): void {
    this.devices.delete(serviceId);
  }

  private saasRow(serviceId: string): RemoteRow {
    const row = this.host.remoteRow(serviceId);
    if (row.kind !== "saas") {
      throw fail("not_implemented", "只有 Armadra 云有空间");
    }
    return row;
  }

  /** 登录后可登记的空间（`me.spaces`）。 */
  async spaces(serviceId: string): Promise<{ spaces: CloudSpace[] }> {
    const { host } = this;
    const row = this.saasRow(serviceId);
    const token = await host.remoteAccess(row);
    return {
      spaces: await host.remote.spaces(host.endpoint(row), token.accessToken),
    };
  }

  /**
   * 按所选空间取注册令牌并把本机登记进去。令牌只在这次调用里转一圈；登记成功后
   * 用同一会话取断言、映射这个账号到本机主人（尽力，失败只记码——分享已经成立，
   * 主人经中继进来时再绑一次）。登记失败不留任何东西。
   */
  async register(input: {
    serviceId: string;
    space: SpaceRef;
    label?: string | undefined;
  }): Promise<{ remote: RemoteService; sourceId: string }> {
    const { host } = this;
    const row = this.saasRow(input.serviceId);
    const label = checkLabel(input.label);
    const cloud = host.cloud?.();
    if (cloud === undefined) {
      throw fail("not_implemented", "本机还没有装云登录域");
    }
    if (cloud.registered(row.issuer)) {
      throw fail("cloud_already_registered", "已经登记到这个远程服务");
    }
    const endpoint = host.endpoint(row);
    const access = await host.remoteAccess(row);
    const registrationToken = await host.remote.registrationToken(
      endpoint,
      access.accessToken,
      input.space,
    );
    const registered = await cloud.register({
      issuer: row.issuer,
      registrationToken,
      ...(label === undefined ? {} : { label }),
    });
    try {
      const signed = await host.remote.assertion(
        endpoint,
        access.accessToken,
        registered.sourceId,
      );
      await cloud.bind(signed.assertion);
    } catch (error) {
      host.log.warn("could not bind the account to this machine", {
        serviceId: row.serviceId,
        code: error instanceof CoreFailure ? error.code : "unknown",
      });
    }
    host.log.info("registered this machine to a remote service", {
      serviceId: row.serviceId,
      space: input.space.kind,
    });
    return {
      remote: await host.remoteJson(host.remoteRow(row.serviceId)),
      sourceId: registered.sourceId,
    };
  }
}
