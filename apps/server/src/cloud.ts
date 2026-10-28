/**
 * `armadra-server cloud …` 与 `armadra-server invite --cloud-link`：对**运行中**的
 * 服务器壳操作个人中转与 Armadra 云（契约 §31、§33、§88，规格 A4-4）。
 *
 * CLI 是另一个进程，登记、隧道与会话都在 serve 进程的 core 里，所以这里只做两件事：
 *
 *   1. **取本机会话**：读 `endpoints.json` 找 core 的回环地址，向数据目录下 0600 的
 *      私有通道（`core-control.sock`）要一张一次性票，在回环上 `POST
 *      /api/identity/pair` 换一份 Bearer。文件权限就是鉴权——和桌面壳、探针同一条路。
 *      Windows 上私有通道不开，这些命令不可用。
 *   2. **直接问远程服务**（只有 `cloud login` 与 `invite --cloud-link --group` 需要）：
 *      用 core 持有的远程服务会话（`sources.remoteSession`）向中继要注册令牌、断言、
 *      建链接。经 core 的 `networkTransport`，按指纹钉扎。Armadra 云的设备码登录、
 *      登记与分享链接都经 core 的 `sources.*` 完成。
 *
 * 凭据只在内存里过一遍：口令、注册令牌、访问令牌不进输出、不进日志、不进错误信息；
 * 唯一打印的秘密是分享链接本身（它就是这条命令的产物）。
 */

import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { read as readEndpoints } from "../../desktop/src/core/endpoints";
import { CONTROL_SOCKET } from "../../desktop/src/core/identity/control";
import { endpointsFile } from "../../desktop/src/core/paths";
import {
  type Transport,
  networkTransport,
  normalizeFingerprint,
  normalizeOrigin,
} from "../../desktop/src/core/sources/http-client";
import { single, switched } from "./cli";

type Values = ReadonlyMap<string, readonly string[]>;

/** 登记令牌的环境变量；容器入口用它，CLI 的 `--token` 缺省也读它。 */
export const TOKEN_ENV = "ARMADRA_CLOUD_REGISTRATION_TOKEN";
/** `cloud login` 的口令环境变量（没有终端、也不想走标准输入时）。 */
export const PASSWORD_ENV = "ARMADRA_CLOUD_PASSWORD";

const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_NAME = "armadra-server cli";

/** 命令的失败：`code` 稳定，`message` 给人看；从不带请求体。 */
export class CloudCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 用法错误（退出码 2）而不是运行失败（1）。 */
    readonly usage = false,
  ) {
    super(message);
  }
}

/** 本机 core 上的一个已登录会话。 */
export interface LocalCore {
  call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown>;
}

export interface CloudDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: (() => Promise<string>) | undefined;
  /** 终端里不回显地读一行（`cloud login` 的口令）；没有终端是 `undefined`。 */
  readonly prompt?: ((label: string) => Promise<string>) | undefined;
  readonly connect: (dataDir: string) => Promise<LocalCore>;
  readonly transport: Transport;
  readonly now: () => number;
  /**
   * 过程中给人看的一行（设备码与验证地址）：写到终端的标准错误，不进 `--output json`
   * 的文档、不进日志。
   */
  readonly notice: (line: string) => void;
  /** 轮询与等隧道之间的停顿；用例换成不等的。 */
  readonly wait?: (ms: number) => Promise<void>;
}

export function defaultDeps(
  io: Pick<CloudDeps, "env" | "stdin" | "prompt"> & {
    readonly stderr?: (line: string) => void;
  },
  overrides: Partial<CloudDeps> = {},
): CloudDeps {
  return {
    env: io.env,
    stdin: io.stdin,
    prompt: io.prompt,
    notice: (line) =>
      io.stderr === undefined
        ? void process.stderr.write(`${line}\n`)
        : io.stderr(`${line}\n`),
    connect: connectLocalCore,
    transport: networkTransport,
    now: Date.now,
    ...overrides,
  };
}

/* ------------------------------- 本机会话 -------------------------------- */

function controlTicket(dataDir: string, origin: string): Promise<string> {
  const body = Buffer.from(
    JSON.stringify({ origin, deviceName: DEVICE_NAME }),
    "utf8",
  );
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        socketPath: join(dataDir, CONTROL_SOCKET),
        path: "/control/identity/ticket",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new CloudCliError("control_refused", "私有通道拒绝签票"));
            return;
          }
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as { ticket?: unknown };
            if (typeof parsed.ticket !== "string") throw new Error("shape");
            resolve(parsed.ticket);
          } catch {
            reject(new CloudCliError("control_refused", "私有通道的答案不对"));
          }
        });
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("timeout")));
    outgoing.on("error", () =>
      reject(
        new CloudCliError(
          "host_unavailable",
          "连不上运行中的服务器壳：先启动 armadra-server serve（同一个 --data-dir）",
        ),
      ),
    );
    outgoing.end(body);
  });
}

function failureOf(status: number, text: string): CloudCliError {
  let code = "internal";
  let message = `请求失败（${status}）`;
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // 不是 JSON：只报状态码，原文不外泄。
  }
  return new CloudCliError(code, message);
}

export async function connectLocalCore(dataDir: string): Promise<LocalCore> {
  if (process.platform === "win32") {
    throw new CloudCliError(
      "unsupported_platform",
      "Windows 上服务器壳没有私有通道，这条命令不可用",
    );
  }
  const base = readEndpoints(endpointsFile(dataDir)).runtime?.http;
  if (base === undefined) {
    throw new CloudCliError(
      "host_unavailable",
      "找不到运行中的服务器壳：先启动 armadra-server serve（同一个 --data-dir）",
    );
  }
  const root = base.replace(/\/+$/, "");
  const origin = new URL(root).origin;
  const ticket = await controlTicket(dataDir, origin);
  let paired: Response;
  try {
    paired = await fetch(`${root}/api/identity/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
  } catch {
    throw new CloudCliError("host_unavailable", "连不上运行中的服务器壳");
  }
  const text = await paired.text();
  if (!paired.ok) throw failureOf(paired.status, text);
  const accessToken = (
    JSON.parse(text) as { native?: { accessToken?: unknown } }
  ).native?.accessToken;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new CloudCliError("control_refused", "配对没有给出会话");
  }
  return {
    async call(method, path, body) {
      let response: Response;
      try {
        response = await fetch(`${root}${path}`, {
          method,
          headers: {
            origin,
            authorization: `Bearer ${accessToken}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new CloudCliError("host_unavailable", "连不上运行中的服务器壳");
      }
      const answer = await response.text();
      if (!response.ok) throw failureOf(response.status, answer);
      return answer === "" ? {} : JSON.parse(answer);
    },
  };
}

/* -------------------------------- 取值 ---------------------------------- */

function usage(message: string): never {
  throw new CloudCliError("usage", message, true);
}

function issuerOf(values: Values): string {
  const given = single(values, "--issuer");
  if (given === undefined)
    usage("需要 --issuer（个人中转或 Armadra 云的地址）");
  try {
    return normalizeOrigin(given);
  } catch {
    return usage(`--issuer 不是一个合法地址：${given}`);
  }
}

function fingerprintOf(values: Values): string {
  try {
    return normalizeFingerprint(single(values, "--fingerprint"));
  } catch {
    return usage("--fingerprint 应为 64 位十六进制");
  }
}

async function firstLine(
  deps: CloudDeps,
  what: string,
): Promise<string | undefined> {
  if (deps.stdin === undefined) return undefined;
  const value = (await deps.stdin()).replace(/\r?\n$/, "");
  if (value === "" || /[\r\n]/.test(value)) {
    usage(`标准输入要是一行非空的${what}`);
  }
  return value;
}

async function registrationToken(
  values: Values,
  deps: CloudDeps,
): Promise<string> {
  if (switched(values, "--token-stdin")) {
    const value = await firstLine(deps, "令牌");
    if (value === undefined) usage("--token-stdin 需要标准输入");
    return value;
  }
  const value = single(values, "--token") ?? deps.env[TOKEN_ENV];
  if (value === undefined || value.trim() === "") {
    return usage(`需要注册令牌：--token、--token-stdin 或 ${TOKEN_ENV}`);
  }
  return value.trim();
}

async function accountPassword(
  values: Values,
  deps: CloudDeps,
): Promise<string> {
  if (switched(values, "--password-stdin")) {
    const value = await firstLine(deps, "口令");
    if (value === undefined) usage("--password-stdin 需要标准输入");
    return value;
  }
  const fromEnv = deps.env[PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (deps.prompt !== undefined) {
    const typed = await deps.prompt("口令：");
    if (typed !== "") return typed;
  }
  return usage(
    `需要口令：--password-stdin、${PASSWORD_ENV}，或在终端里运行以便提示输入`,
  );
}

/** `7d` / `12h` / `30m` → 毫秒；core 再夹到 30 天。 */
export function parseExpires(value: string): number | undefined {
  const match = /^(\d{1,6})([mhd])$/.exec(value);
  if (match === null) return undefined;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "m" | "h" | "d"
  ];
  const ms = Number(match[1]) * unit;
  return ms > 0 ? ms : undefined;
}

/* ------------------------------ 个人中转 -------------------------------- */

interface TunnelView {
  state: string;
  node: string | null;
}

function tunnelText(tunnel: TunnelView | undefined): string {
  if (tunnel === undefined) return "未知";
  return tunnel.node === null
    ? tunnel.state
    : `${tunnel.state}（${tunnel.node}）`;
}

async function relayCall(
  deps: CloudDeps,
  input: {
    issuer: string;
    fingerprint: string;
    method: "GET" | "POST";
    path: string;
    accessToken: string;
    body?: unknown;
  },
): Promise<Record<string, unknown>> {
  let answer: Awaited<ReturnType<Transport>>;
  try {
    answer = await deps.transport({
      method: input.method,
      url: `${input.issuer}${input.path}`,
      headers: { authorization: `Bearer ${input.accessToken}` },
      ...(input.body === undefined ? {} : { body: input.body }),
      fingerprint: input.fingerprint,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new CloudCliError(
      typeof code === "string" ? code : "source_unreachable",
      error instanceof Error ? error.message : "连不上个人中转",
    );
  }
  const body =
    typeof answer.body === "object" && answer.body !== null
      ? (answer.body as Record<string, unknown>)
      : {};
  if (answer.status < 200 || answer.status >= 300) {
    throw new CloudCliError(
      typeof body.code === "string" ? body.code : "source_unreachable",
      typeof body.message === "string"
        ? body.message
        : `个人中转没有完成请求（${answer.status}）`,
    );
  }
  return body;
}

interface RemoteRow {
  serviceId: string;
  kind?: "personal" | "saas";
  issuer: string;
  fingerprint: string;
  registered: boolean;
  hasCredentials?: boolean;
}

async function remoteFor(core: LocalCore, issuer: string): Promise<RemoteRow> {
  const listed = (await core.call("GET", "/api/sources")) as {
    remotes?: RemoteRow[];
  };
  const found = (listed.remotes ?? []).find((row) => row.issuer === issuer);
  if (found === undefined) {
    throw new CloudCliError(
      "not_found",
      `没有登录这个远程服务：先 armadra-server cloud login --issuer ${issuer}`,
    );
  }
  return found;
}

/** 远程服务的模式（`platform.info`，匿名、按指纹钉扎）。 */
async function platformMode(
  deps: CloudDeps,
  issuer: string,
  fingerprint: string,
): Promise<"personal" | "saas"> {
  let answer: Awaited<ReturnType<Transport>>;
  try {
    answer = await deps.transport({
      method: "GET",
      url: `${issuer}/.well-known/armadra-platform`,
      headers: {},
      fingerprint,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new CloudCliError(
      typeof code === "string" ? code : "source_unreachable",
      error instanceof Error ? error.message : "连不上这个远程服务",
    );
  }
  const mode =
    typeof answer.body === "object" && answer.body !== null
      ? (answer.body as { mode?: unknown }).mode
      : undefined;
  if (answer.status !== 200 || (mode !== "personal" && mode !== "saas")) {
    throw new CloudCliError(
      "source_unreachable",
      "这个地址不是个人中转，也不是 Armadra 云",
    );
  }
  return mode;
}

async function remoteAccess(
  core: LocalCore,
  serviceId: string,
): Promise<string> {
  const session = (await core.call(
    "POST",
    `/api/sources/remotes/${serviceId}/session`,
    {},
  )) as { accessToken?: unknown };
  if (typeof session.accessToken !== "string" || session.accessToken === "") {
    throw new CloudCliError("source_unauthorized", "个人中转的登录已失效");
  }
  return session.accessToken;
}

type Emit = (document: unknown, text: () => string) => void;

async function register(
  core: LocalCore,
  body: {
    issuer: string;
    registrationToken: string;
    label?: string | undefined;
    fingerprint?: string | undefined;
  },
): Promise<{ registered: boolean; tunnel?: TunnelView }> {
  try {
    const answer = (await core.call("POST", "/api/identity/cloud/register", {
      issuer: body.issuer,
      registrationToken: body.registrationToken,
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.fingerprint === undefined || body.fingerprint === ""
        ? {}
        : { fingerprint: body.fingerprint }),
    })) as { tunnel?: TunnelView };
    return {
      registered: true,
      ...(answer.tunnel === undefined ? {} : { tunnel: answer.tunnel }),
    };
  } catch (error) {
    // 幂等：已经登记过就当完成（容器每次启动都会跑一遍）。
    if (
      error instanceof CloudCliError &&
      error.code === "cloud_already_registered"
    ) {
      return { registered: false };
    }
    throw error;
  }
}

/** 登记后隧道要几秒才连上；等到 ready 或超时，返回最后看到的状态。 */
async function settle(
  core: LocalCore,
  issuer: string,
  deps: CloudDeps,
  wait: (ms: number) => Promise<void>,
): Promise<TunnelView | undefined> {
  const deadline = deps.now() + 10_000;
  let last: TunnelView | undefined;
  for (;;) {
    const status = (await core.call("GET", "/api/identity/cloud")) as {
      registrations?: { issuer: string; tunnel?: TunnelView }[];
    };
    last = status.registrations?.find((row) => row.issuer === issuer)?.tunnel;
    if (last?.state === "ready" || deps.now() >= deadline) return last;
    await wait(500);
  }
}

/**
 * 把登录用的中继账号映射到本机 owner（契约 §31 `bind`）：向中继要一张为本机签的断言，
 * 交给 core。不映射的话这个账号经中继进来是 `cloud_account_unlinked`（#377）。
 * 已经映射过（`conflict`）不算失败，`cloud login` 因此可以重复跑。
 */
async function bindOwner(
  core: LocalCore,
  deps: CloudDeps,
  input: { issuer: string; fingerprint: string; accessToken: string },
): Promise<"bound" | "replaced" | "conflict"> {
  const status = (await core.call("GET", "/api/identity/cloud")) as {
    sourceId?: string;
  };
  if (status.sourceId === undefined || status.sourceId === "") {
    throw new CloudCliError("internal", "本机没有给出来源编号");
  }
  const signed = await relayCall(deps, {
    issuer: input.issuer,
    fingerprint: input.fingerprint,
    method: "POST",
    path: `/v1/sources/${encodeURIComponent(status.sourceId)}/assertion`,
    accessToken: input.accessToken,
    body: {},
  });
  if (typeof signed.assertion !== "string" || signed.assertion === "") {
    throw new CloudCliError("source_unreachable", "个人中转没有给出断言");
  }
  try {
    const answer = (await core.call("POST", "/api/identity/cloud/bind", {
      assertion: signed.assertion,
    })) as { replaced?: unknown };
    // 契约 §88.5：替换了云端准入自动建的成员时答案带 `replaced: true`。
    return answer.replaced === true ? "replaced" : "bound";
  } catch (error) {
    if (!(error instanceof CloudCliError && error.code === "conflict")) {
      throw error;
    }
    return "conflict";
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export async function runCloud(
  positionals: readonly string[],
  values: Values,
  dataDir: string,
  deps: CloudDeps,
  emit: Emit,
  wait: (ms: number) => Promise<void> = deps.wait ?? sleep,
): Promise<void> {
  const action = positionals[0];
  if (
    action !== "register" &&
    action !== "revoke" &&
    action !== "status" &&
    action !== "login"
  ) {
    usage("用法: armadra-server cloud register | revoke | status | login");
  }
  // 参数与凭据先于任何连接取齐：用法错误不该先去敲运行中的服务。
  if (action === "register") {
    const issuer = issuerOf(values);
    const token = await registrationToken(values, deps);
    const fingerprint = fingerprintOf(values);
    const label = single(values, "--label");
    const core = await deps.connect(dataDir);
    const done = await register(core, {
      issuer,
      registrationToken: token,
      label,
      fingerprint,
    });
    const tunnel = done.registered
      ? await settle(core, issuer, deps, wait)
      : undefined;
    emit({ command: "cloud register", issuer, ...done, tunnel }, () =>
      done.registered
        ? `已登记 ${issuer}，隧道 ${tunnelText(tunnel)}`
        : `已经登记到 ${issuer}，跳过`,
    );
    return;
  }
  if (action === "revoke") {
    const issuer = issuerOf(values);
    const core = await deps.connect(dataDir);
    await core.call(
      "DELETE",
      `/api/identity/cloud/register?issuer=${encodeURIComponent(issuer)}`,
    );
    // 中继侧的源记录要远程服务 owner 的会话才删得掉（契约 §31.4）；服务器壳多半
    // 没有那份会话，没删掉就如实说「中继侧待清理」和码。
    const pending = (await core.call(
      "GET",
      "/api/identity/cloud/relay-pending",
    )) as { pending?: { issuer?: string; code?: string }[] };
    const relayPending =
      pending.pending?.find((one) => one.issuer === issuer)?.code ?? null;
    emit(
      { command: "cloud revoke", issuer, revoked: true, relayPending },
      () =>
        relayPending === null
          ? `已撤销 ${issuer} 的登记`
          : `已撤销 ${issuer} 的登记；中继侧待清理（${relayPending}）`,
    );
    return;
  }
  if (action === "status") {
    const core = await deps.connect(dataDir);
    const status = (await core.call("GET", "/api/identity/cloud")) as {
      sourceId?: string;
      registrations?: {
        issuer: string;
        mode: string;
        label?: string;
        tunnel?: TunnelView;
        relayOrigins?: string[];
      }[];
    };
    const rows = status.registrations ?? [];
    emit(
      {
        command: "cloud status",
        sourceId: status.sourceId,
        registrations: rows,
      },
      () =>
        rows.length === 0
          ? "没有登记到任何个人中转"
          : rows
              .map(
                (row) =>
                  `${row.issuer}（${row.mode}）隧道 ${tunnelText(row.tunnel)}`,
              )
              .join("\n"),
    );
    return;
  }
  // login：按远程服务的模式分流。参数先于连接取齐。
  const issuer = issuerOf(values);
  const fingerprint = fingerprintOf(values);
  const label = single(values, "--label");
  const account = single(values, "--account");
  const space = single(values, "--space");
  const mode = await platformMode(deps, issuer, fingerprint);
  if (mode === "saas") {
    if (account !== undefined) usage("Armadra 云用设备码登录，不收 --account");
    await saasLogin({ issuer, label, space }, dataDir, deps, emit, wait);
    return;
  }
  if (space !== undefined) usage("--space 只用于 Armadra 云");
  if (account === undefined || account === "") usage("需要 --account");
  const password = await accountPassword(values, deps);
  const core = await deps.connect(dataDir);
  const added = (await core.call("POST", "/api/sources/remotes", {
    kind: "personal",
    issuer,
    account,
    password,
    ...(label === undefined ? {} : { label }),
    ...(fingerprint === "" ? {} : { fingerprint }),
  })) as { remote?: RemoteRow };
  const remote = added.remote;
  if (remote === undefined) {
    throw new CloudCliError("internal", "登录的答案不完整");
  }
  const access = await remoteAccess(core, remote.serviceId);
  const issued = await relayCall(deps, {
    issuer,
    fingerprint: remote.fingerprint,
    method: "POST",
    path: "/v1/sources/registration-tokens",
    accessToken: access,
    body: {},
  });
  if (typeof issued.registrationToken !== "string") {
    throw new CloudCliError("source_unreachable", "个人中转没有给出注册令牌");
  }
  const done = await register(core, {
    issuer,
    registrationToken: issued.registrationToken,
    label,
  });
  const tunnel = done.registered
    ? await settle(core, issuer, deps, wait)
    : undefined;
  // 登记（或早已登记）之后，这个账号就是本机的主人：映射好，经中继才进得来。
  await bindOwner(core, deps, {
    issuer,
    fingerprint: remote.fingerprint,
    accessToken: access,
  });
  emit(
    { command: "cloud login", issuer, account, ...done, bound: true, tunnel },
    () =>
      done.registered
        ? `已登录 ${issuer} 并登记，账号已关联为本机主人，隧道 ${tunnelText(tunnel)}`
        : `已登录 ${issuer}；本机早已登记，账号已关联为本机主人`,
  );
}

/* ----------------------------- Armadra 云登录 ---------------------------- */

interface DeviceCode {
  userCode: string;
  verificationUrl: string;
  expiresAtMs: number;
  intervalMs?: number;
}

/** 设备码轮询的最短间隔（core 也按服务端要求兜底）。 */
const MIN_POLL_MS = 2_000;

/**
 * Armadra 云（设计 §4.4、§2.6）：设备码登录（码与验证地址只到终端），批准后——
 *
 * - 本机还没登记到它：按 `--space` 登记（`sources.remoteRegister`，登记并映射主人）；
 * - 本机已登记（例如先 `cloud register --token`）：**只绑定**——不再登记（会答
 *   `cloud_already_registered`），经远程会话取一张为本机签的断言交给 core `bind`，
 *   把这个账号映射为本机主人。映射若已指向云端准入自动建的成员，core 迁到主人
 *   （契约 §88.5）。
 */
async function saasLogin(
  input: {
    issuer: string;
    label: string | undefined;
    space: string | undefined;
  },
  dataDir: string,
  deps: CloudDeps,
  emit: Emit,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const { issuer } = input;
  const core = await deps.connect(dataDir);
  const added = (await core.call("POST", "/api/sources/remotes", {
    kind: "saas",
    issuer,
    ...(input.label === undefined ? {} : { label: input.label }),
  })) as {
    remote?: RemoteRow;
    next?: "ready" | { deviceCode?: DeviceCode };
  };
  const remote = added.remote;
  if (remote === undefined || added.next === undefined) {
    throw new CloudCliError("internal", "登录的答案不完整");
  }
  if (added.next !== "ready") {
    const code = added.next.deviceCode;
    if (code === undefined) {
      throw new CloudCliError("internal", "登录的答案不完整");
    }
    deps.notice(
      `在浏览器打开 ${code.verificationUrl} 并输入设备码 ${code.userCode}（核对后批准）`,
    );
    await awaitApproval(core, remote.serviceId, code, deps, wait);
  }
  const status = (await core.call("GET", "/api/identity/cloud")) as {
    registrations?: { issuer: string }[];
  };
  const already = (status.registrations ?? []).some(
    (row) => row.issuer === issuer,
  );
  let tunnel: TunnelView | undefined;
  if (!already) {
    const target = await spaceOf(core, remote.serviceId, input.space);
    await core.call(
      "POST",
      `/api/sources/remotes/${remote.serviceId}/register`,
      {
        space: target,
        ...(input.label === undefined ? {} : { label: input.label }),
      },
    );
    tunnel = await settle(core, issuer, deps, wait);
  } else if (input.space !== undefined) {
    deps.notice("本机已经登记到这个 Armadra 云，忽略 --space");
  }
  // 登记时 core 已尽力映射；这里再确认一次（已映射给自己是幂等的）。
  const access = await remoteAccess(core, remote.serviceId);
  const bound = await bindOwner(core, deps, {
    issuer,
    fingerprint: remote.fingerprint,
    accessToken: access,
  });
  // 设备码批准之后账号名才写进行里：重读一次，告诉人关联的是哪个账号。
  const account = await accountHintOf(core, remote.serviceId);
  emit(
    {
      command: "cloud login",
      issuer,
      mode: "saas",
      account,
      registered: !already,
      bound: bound !== "conflict",
      replaced: bound === "replaced",
      tunnel,
    },
    () => {
      const who = account === "" ? "" : `（${account}）`;
      const owner =
        bound === "conflict"
          ? "这个账号已关联到本机的另一个人，没有改动（在账号页撤销那条关联后重试）"
          : bound === "replaced"
            ? "账号已关联为本机主人，已停用之前云端自动建的同一账号的成员"
            : "账号已关联为本机主人";
      return already
        ? `已登录 ${issuer}${who}；本机早已登记，${owner}`
        : `已登录 ${issuer}${who} 并登记，${owner}，隧道 ${tunnelText(tunnel)}`;
    },
  );
}

/** 远程服务行上的账号提示（邮箱或显示名）；取不到是空串。 */
async function accountHintOf(
  core: LocalCore,
  serviceId: string,
): Promise<string> {
  const listed = (await core.call("GET", "/api/sources")) as {
    remotes?: { serviceId: string; accountHint?: unknown }[];
  };
  const hint = listed.remotes?.find(
    (row) => row.serviceId === serviceId,
  )?.accountHint;
  return typeof hint === "string" ? hint : "";
}

/** 等人在浏览器里批准设备码：按间隔轮询，拒绝或过期即失败。 */
async function awaitApproval(
  core: LocalCore,
  serviceId: string,
  code: DeviceCode,
  deps: CloudDeps,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const interval = Math.max(code.intervalMs ?? 5_000, MIN_POLL_MS);
  for (;;) {
    if (deps.now() >= code.expiresAtMs) {
      throw new CloudCliError(
        "device_expired",
        "设备码已过期，重新运行这条命令",
      );
    }
    await wait(interval);
    let status: string | undefined;
    try {
      status = (
        (await core.call(
          "POST",
          `/api/sources/remotes/${serviceId}/poll`,
          {},
        )) as { status?: string }
      ).status;
    } catch (error) {
      // 轮询过快被限流：多等一个间隔再问。
      if (error instanceof CloudCliError && error.code === "rate_limited") {
        await wait(interval);
        continue;
      }
      throw error;
    }
    if (status === "ready") return;
    if (status === "denied") {
      throw new CloudCliError("device_denied", "登录请求被拒绝");
    }
    if (status === "expired") {
      throw new CloudCliError(
        "device_expired",
        "设备码已过期，重新运行这条命令",
      );
    }
  }
}

/** `--space personal | <团队 slug>` → 登记的空间；不给就是个人空间。 */
async function spaceOf(
  core: LocalCore,
  serviceId: string,
  space: string | undefined,
): Promise<{ kind: "personal" } | { kind: "team"; teamId: string }> {
  const listed = (await core.call(
    "GET",
    `/api/sources/remotes/${serviceId}/spaces`,
  )) as {
    spaces?: (
      | { kind: "personal" }
      | { kind: "team"; teamId: string; slug: string }
    )[];
  };
  const spaces = listed.spaces ?? [];
  if (space === undefined || space === "personal") {
    if (!spaces.some((one) => one.kind === "personal")) {
      throw new CloudCliError("not_found", "这个账号没有个人空间");
    }
    return { kind: "personal" };
  }
  const team = spaces.find(
    (one): one is { kind: "team"; teamId: string; slug: string } =>
      one.kind === "team" && one.slug === space,
  );
  if (team === undefined) {
    const slugs = spaces
      .filter((one) => one.kind === "team")
      .map((one) => (one as { slug: string }).slug);
    return usage(
      `没有这个团队：${space}（可选：personal${slugs.map((one) => `、${one}`).join("")}）`,
    );
  }
  return { kind: "team", teamId: team.teamId };
}

/* ------------------------------- 分享链接 ------------------------------- */

/** 缺省有效期：7 天（core 再夹到 30 天）。 */
const DEFAULT_LINK_TTL_MS = 7 * 86_400_000;

/**
 * `invite --cloud-link`（设计 §4.4，Q7）：经本机 core 的 `sources.shareLinkCreate` 建
 * 链接——个人中转与 Armadra 云同一条，链接带三段片段（秘密、邀请令牌、身份指纹前缀），
 * 整条存进 SecretStore，之后在分享弹层里还能再复制。`--host`（整台）与 `--workspace`
 * 二选一；`--group` 只留给个人中转的旧路径（本机签一张组邀请，再请中继建链接），
 * Armadra 云上明确报错。
 */
export async function runInvite(
  values: Values,
  dataDir: string,
  deps: CloudDeps,
  emit: Emit,
): Promise<void> {
  if (!switched(values, "--cloud-link")) {
    usage("invite 目前只支持 --cloud-link（经远程服务生成分享链接）");
  }
  const issuer = issuerOf(values);
  const workspace = single(values, "--workspace");
  const group = single(values, "--group");
  const host = switched(values, "--host");
  if (
    [workspace !== undefined, group !== undefined, host].filter(Boolean)
      .length !== 1
  ) {
    usage("--host、--workspace 与 --group 三选一");
  }
  const role = single(values, "--role") ?? "viewer";
  const maxText = single(values, "--max-uses");
  let maxUses: number | undefined;
  if (maxText !== undefined) {
    maxUses = /^\d{1,4}$/.test(maxText) ? Number(maxText) : 0;
    if (maxUses < 1 || maxUses > 1000)
      usage("--max-uses 应为 1 到 1000 的整数");
  }
  const expiresText = single(values, "--expires");
  let ttlMs: number | undefined;
  if (expiresText !== undefined) {
    ttlMs = parseExpires(expiresText);
    if (ttlMs === undefined) usage("--expires 形如 30m、12h、7d");
  }
  const label = (single(values, "--label") ?? "Armadra").slice(0, 128);
  const core = await deps.connect(dataDir);
  const remote = await remoteFor(core, issuer);
  if (group !== undefined && remote.kind === "saas") {
    usage("Armadra 云的链接不支持组，用 --host 或 --workspace");
  }
  const status = (await core.call("GET", "/api/identity/cloud")) as {
    sourceId?: string;
    registrations?: { issuer: string }[];
  };
  if (
    status.sourceId === undefined ||
    !(status.registrations ?? []).some((row) => row.issuer === issuer)
  ) {
    throw new CloudCliError(
      "cloud_not_registered",
      "本机还没有登记到这个远程服务：先 armadra-server cloud register 或 cloud login",
    );
  }
  if (group !== undefined) {
    await groupInvite(core, deps, emit, {
      issuer,
      remote,
      sourceId: status.sourceId,
      group,
      role,
      label,
      maxUses,
      ttlMs,
    });
    return;
  }
  const created = (await core.call(
    "POST",
    `/api/sources/remotes/${remote.serviceId}/links`,
    {
      target: host ? "host" : "workspace",
      workspaceId: workspace ?? "",
      role,
      ttlMs: ttlMs ?? DEFAULT_LINK_TTL_MS,
      maxUses: maxUses ?? 1,
      label,
    },
  )) as {
    url?: unknown;
    link?: { linkId?: string; expiresAtMs?: number; role?: string };
  };
  if (typeof created.url !== "string") {
    throw new CloudCliError("source_unreachable", "远程服务没有给出分享链接");
  }
  const url = created.url;
  emit(
    {
      command: "invite",
      cloudLink: true,
      linkId: created.link?.linkId,
      url,
      expiresAtMs: created.link?.expiresAtMs,
      maxUses: maxUses ?? 1,
      role: created.link?.role ?? role,
      target: host ? "host" : "workspace",
    },
    () => url,
  );
}

/** 个人中转的组邀请（旧路径）：本机签组邀请，再请中继建一条指向它的链接。 */
async function groupInvite(
  core: LocalCore,
  deps: CloudDeps,
  emit: Emit,
  input: {
    issuer: string;
    remote: RemoteRow;
    sourceId: string;
    group: string;
    role: string;
    label: string;
    maxUses: number | undefined;
    ttlMs: number | undefined;
  },
): Promise<void> {
  const { issuer, remote, role, maxUses, ttlMs } = input;
  const access = await remoteAccess(core, remote.serviceId);
  const invitation = (await core.call("POST", "/api/identity/invitations", {
    role,
    targetGroupId: input.group,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(maxUses === undefined ? {} : { maxUses }),
  })) as { invitationId: string; token: string; expiresAtMs: number };
  try {
    const link = await relayCall(deps, {
      issuer,
      fingerprint: remote.fingerprint,
      method: "POST",
      path: "/v1/links",
      accessToken: access,
      body: {
        kind: "source_invite",
        sourceId: input.sourceId,
        invitationId: invitation.invitationId,
        label: input.label,
        role,
        expiresAtMs: invitation.expiresAtMs,
        ...(maxUses === undefined ? {} : { maxUses }),
      },
    });
    if (typeof link.url !== "string" || typeof link.secret !== "string") {
      throw new CloudCliError("source_unreachable", "个人中转没有给出分享链接");
    }
    const url = `${link.url}#${link.secret}.${invitation.token}`;
    emit(
      {
        command: "invite",
        cloudLink: true,
        invitationId: invitation.invitationId,
        linkId: link.linkId,
        url,
        expiresAtMs: link.expiresAtMs ?? invitation.expiresAtMs,
        maxUses: maxUses ?? 1,
        role,
      },
      () => url,
    );
  } catch (error) {
    // 链接没建成：邀请不留着，免得一张没人知道的门票挂在库里。
    await core
      .call("DELETE", `/api/identity/invitations/${invitation.invitationId}`)
      .catch(() => undefined);
    throw error;
  }
}
