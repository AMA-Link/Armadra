import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import type { CollabContext } from "../collab/service";
import { loadNode, loadSession } from "../collab/nodes";
import { grokCardKey, parseGrokApprovalCard } from "./grok-card";
import { refreshNodeState } from "./state-source";
import type { AgentApproval } from "./approvals";
import { baseAgent } from "./registry";

/**
 * 在终端里替人答 grok 的权限卡（契约 §127）。
 *
 * grok 的审批卡是编号会跳号的菜单，数字键选中即提交，且有 Always / Never 这类写
 * 进用户规则的选项，所以代答只在这些全部成立时发生：
 *
 *   * **两道门**：代码里的已验证版本清单（{@link GROK_ANSWER_VERIFIED_VERSIONS}，
 *     离线 e2e 通过后才填）与用户设置（缺省关）；
 *   * **节点是 Armadra 自己带 `--permission-mode` 启动的**（`auto-edit` / `plan`）：
 *     缺省模式是 auto-review，分类器是不经键盘的第三个答题者，没验证过；
 *   * **有审批记录**：读取槽认得出这张卡（{@link parseGrokApprovalCard}）才建，记录里
 *     有 `permission_requested` 行的字节偏移作请求身份；
 *   * **发键前三项核对**：恰好一条未决请求且偏移与记录一致、`inputRevision` 没动、
 *     再抓一屏卡片正文哈希与记录相同；
 *   * **发完核对**：偏移之后恰好一条 resolved 且决定与预期相同，否则报
 *     `delivery`（`unconfirmed` / `mismatch` / `ambiguous`），不重发。
 */

/** 已在 Armadra 的离线 e2e 里验证过卡片结构的 grok 版本；空 = 谁都不开。 */
export const GROK_ANSWER_VERIFIED_VERSIONS: readonly string[] = ["1.0.92"];

/** 用户设置里的开关（缺省关）：`agents.grok.answerCards`。 */
export const GROK_ANSWER_SETTING = "agents.grok.answerCards";

/** 审批记录 `request.protocol` 的值：这条审批答在 grok 的终端卡上。 */
export const GROK_CARD_PROTOCOL = "grok-card";

/** 能放开的启动模式：grok 进程自己的 argv 里带 `--permission-mode acceptEdits | plan`。 */
const GATED_MODES: readonly string[] = ["auto-edit", "plan"];

/** `--permission-mode` 的取值 → 这里用的名字（与 `launch.ts` 的 `permissionFlag` 同一张表）。 */
const MODE_OF_FLAG: Readonly<Record<string, string>> = {
  acceptEdits: "auto-edit",
  plan: "plan",
};

export type GrokGate =
  | { readonly open: true }
  | {
      readonly open: false;
      readonly reason: "unverified_version" | "setting_off" | "mode_excluded";
    };

/** 读到的 grok 进程：可执行文件路径与 argv（读不到的项缺席）。 */
export interface GrokProcessInfo {
  readonly exe?: string | undefined;
  readonly args?: readonly string[] | undefined;
  /**
   * argv 是逐个参数原样读到的（Linux 的 `/proc/<pid>/cmdline`）。别处只拿到一整行
   * （`ps`），按空白切开，引号里的提示词也会被切成「参数」，认不准。
   */
  readonly exact?: boolean | undefined;
}

/** 这个 grok 进程实际的启动方式：模式（按 argv 认）与它跑的可执行文件。 */
export interface GrokLaunch {
  /** `auto-edit` / `plan`；没有旗标、旗标不止一个、值不认识、读不到 argv 都是 `undefined`。 */
  readonly mode: string | undefined;
  readonly exe: string | undefined;
  /** argv 是不是逐个参数原样读到的。 */
  readonly exact: boolean;
}

/**
 * 从进程的 argv 认出权限模式。只看 `--` 之前（之后全是用户的提示词）；
 * `--permission-mode <值>` 与 `--permission-mode=<值>` 都认。**旗标出现不止一次就当读
 * 不出来**：grok 自己不接受重复的旗标，重复只会是提示词里写了同样的字。取值不在表里
 * 同样不认。读不到 argv 答 `mode: undefined`——按模式不在范围算。
 */
export function launchOfProcess(info: GrokProcessInfo | undefined): GrokLaunch {
  const exe = info?.exe;
  const exact = info?.exact === true;
  const args = info?.args;
  if (args === undefined) return { mode: undefined, exe, exact };
  const values: (string | undefined)[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? "";
    if (arg === "--") break;
    if (arg === "--permission-mode") values.push(args[at + 1]);
    else if (arg.startsWith("--permission-mode=")) {
      values.push(arg.slice("--permission-mode=".length));
    }
  }
  const only = values.length === 1 ? values[0] : undefined;
  return {
    mode: only === undefined ? undefined : MODE_OF_FLAG[only],
    exe,
    exact,
  };
}

let verifiedVersions: readonly string[] = GROK_ANSWER_VERIFIED_VERSIONS;

/** 用例用：换掉已验证版本清单；`undefined` 还原成代码里的那份。 */
export function useGrokVerifiedVersions(
  list: readonly string[] | undefined,
): void {
  verifiedVersions = list ?? GROK_ANSWER_VERIFIED_VERSIONS;
}

/**
 * 两道门与模式的判定。顺序就是头部说的话：用户没开设置就什么也不说；然后是这个
 * 进程为什么不行（模式），最后是这个版本为什么不行。版本由调用方探到。
 */
export function grokAnswerGate(input: {
  readonly setting: unknown;
  readonly permissionMode: string | undefined;
  readonly version: string | undefined;
  readonly verified?: readonly string[];
}): GrokGate {
  const verified = input.verified ?? verifiedVersions;
  if (input.setting !== true) return { open: false, reason: "setting_off" };
  if (
    input.permissionMode === undefined ||
    !GATED_MODES.includes(input.permissionMode)
  ) {
    return { open: false, reason: "mode_excluded" };
  }
  if (input.version === undefined || !verified.includes(input.version)) {
    return { open: false, reason: "unverified_version" };
  }
  return { open: true };
}

/** 节点数据里声明的权限模式；没有声明是 `undefined`。 */
export function nodePermissionMode(
  database: CollabContext["database"],
  nodeId: string,
): string | undefined {
  const agent = loadNode(database, nodeId)?.data.agent;
  if (typeof agent !== "object" || agent === null) return undefined;
  const mode = (agent as { permissionMode?: unknown }).permissionMode;
  return typeof mode === "string" ? mode : undefined;
}

/**
 * 「这张卡要不要建审批记录 / 能不能答」的判定。顺序：设置、已验证清单（空的就不用
 * 往下）、进程的启动方式（这时才去读 argv）、版本（这时才去探可执行文件）。设置关着
 * 或清单是空的，不会为 grok 读进程也不会起子进程。
 *
 * 不是逐个参数读到的 argv（非 Linux 的 `ps`）还得与节点声明的权限模式一致才放开：
 * 一整行里引号内的提示词可以冒充旗标，声明的模式是第二个来源。
 */
export async function cardAnswerGate(input: {
  readonly setting: unknown;
  readonly launch: () => GrokLaunch;
  readonly declared?: () => string | undefined;
  readonly probe?: (exe: string | undefined) => Promise<string | undefined>;
  readonly verified?: readonly string[];
}): Promise<GrokGate> {
  const verified = input.verified ?? verifiedVersions;
  if (input.setting !== true) return { open: false, reason: "setting_off" };
  if (verified.length === 0) {
    return { open: false, reason: "unverified_version" };
  }
  const launch = input.launch();
  const matches = launch.exact || input.declared?.() === launch.mode;
  const early = grokAnswerGate({
    setting: true,
    permissionMode: matches ? launch.mode : undefined,
    // 版本留给下面探；这里只看设置与模式。
    version: verified[0],
    verified,
  });
  if (!early.open) return early;
  const version = await (input.probe ?? probeGrokVersion)(launch.exe);
  return grokAnswerGate({
    setting: true,
    permissionMode: launch.mode,
    version,
    verified,
  });
}

/** 探到的版本留多久：grok 自更新之后不会一直拿着旧答案。 */
export const GROK_VERSION_TTL_MS = 10 * 60_000;

const versionProbes = new Map<
  string,
  { at: number; value: Promise<string | undefined> }
>();
let forcedVersion: string | undefined;

/**
 * 这个可执行文件的版本（`<exe> --version`），按「路径 + 修改时间 + 大小」缓存
 * {@link GROK_VERSION_TTL_MS}（grok 自更新换了文件，旧答案就不作数）；探不到（没有
 * 路径、读不到文件、跑不起来、输出里没有版本号）答 `undefined`。路径来自 grok
 * 进程自己，不是 core 的 PATH。
 */
export function probeGrokVersion(
  exe: string | undefined,
  run: typeof execFile = execFile,
  now: () => number = Date.now,
): Promise<string | undefined> {
  if (forcedVersion !== undefined) return Promise.resolve(forcedVersion);
  if (exe === undefined || exe === "") return Promise.resolve(undefined);
  let key: string;
  try {
    const stat = statSync(exe);
    key = `${exe}\u0000${stat.mtimeMs}\u0000${stat.size}`;
  } catch {
    return Promise.resolve(undefined);
  }
  const cached = versionProbes.get(key);
  if (cached !== undefined && now() - cached.at < GROK_VERSION_TTL_MS) {
    return cached.value;
  }
  const value = new Promise<string | undefined>((resolve) => {
    try {
      run(exe, ["--version"], { timeout: 3000 }, (error, stdout) => {
        const match =
          error === null ? /\b(\d+\.\d+\.\d+)\b/.exec(stdout) : null;
        resolve(match?.[1]);
      });
    } catch {
      resolve(undefined);
    }
  });
  versionProbes.set(key, { at: now(), value });
  return value;
}

/** 用例用：忘掉探到的版本；给一个版本就让所有探测都答它。 */
export function resetGrokVersionProbe(version?: string): void {
  versionProbes.clear();
  forcedVersion = version;
}

/* --------------------------------- 读取槽 --------------------------------- */

export interface GrokOpenRequest {
  readonly sessionId: string;
  readonly offset: number;
  readonly tool: string;
}

export type GrokOutcome =
  "allow" | "deny" | "pending" | "ambiguous" | "unknown";

/** 读取槽给答复流程的两个只读问题。 */
export interface GrokCardSource {
  /** 现在所有会话里没答的请求。 */
  requests(): readonly GrokOpenRequest[];
  /** 偏移处的请求之后文件里发生了什么。 */
  outcomeAfter(sessionId: string, offset: number): GrokOutcome;
  /** 这个会话的 grok 进程实际的启动方式（读它的 argv 与可执行文件，不看节点声明的）。 */
  launch(sessionId: string): GrokLaunch;
}

const sources = new Map<string, GrokCardSource>();

/** 读取槽打开时登记，停时撤销。 */
export function registerGrokCardSource(
  nodeId: string,
  source: GrokCardSource,
): () => void {
  sources.set(nodeId, source);
  return () => {
    if (sources.get(nodeId) === source) sources.delete(nodeId);
  };
}

/* ---------------------------------- 记录 ---------------------------------- */

/** 记录里存的卡：不含选项以外的任何东西，也不含 `hash` 之外的画面。 */
export interface GrokCardRecord {
  readonly protocol: typeof GROK_CARD_PROTOCOL;
  readonly sessionId: string;
  readonly offset: number;
  readonly hash: string;
  readonly tool: string;
  readonly title: string;
  readonly body: readonly string[];
  readonly options: readonly string[];
}

export function grokCardRecordOf(request: unknown): GrokCardRecord | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const raw = request as Record<string, unknown>;
  if (
    raw.protocol !== GROK_CARD_PROTOCOL ||
    typeof raw.sessionId !== "string" ||
    typeof raw.offset !== "number" ||
    typeof raw.hash !== "string"
  ) {
    return undefined;
  }
  return raw as unknown as GrokCardRecord;
}

/* ---------------------------------- 核对 ---------------------------------- */

export type GrokRefusal =
  | "card_changed"
  | "card_unrecognized"
  | "input_changed"
  | "no_terminal"
  | "not_grok"
  | "gate_closed";

/** `not_sent`：核对没过，一个键都没发，请人在终端里答。 */
export type GrokDelivery =
  "confirmed" | "unconfirmed" | "mismatch" | "ambiguous" | "not_sent";

interface Checked {
  readonly ok: true;
  readonly key: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly record: GrokCardRecord;
}

/** 与记录同一张卡、且是唯一一条未决请求。同步。 */
function sameRequest(
  source: GrokCardSource | undefined,
  record: GrokCardRecord,
): boolean {
  const open = source?.requests() ?? [];
  const only = open.length === 1 ? open[0] : undefined;
  return (
    only !== undefined &&
    only.sessionId === record.sessionId &&
    only.offset === record.offset
  );
}

/**
 * 发键之前的全部核对；通过给出要按的键。预检（CAS 之前）与发送（CAS 之后）各调
 * 一次：中间隔着一次落库，卡可能已经换了。
 */
export async function verifyGrokCard(
  context: CollabContext,
  approval: AgentApproval,
  decision: string,
): Promise<Checked | { readonly ok: false; readonly reason: GrokRefusal }> {
  const record = grokCardRecordOf(approval.request);
  // 形状像 grok-card 的请求不够：这个节点得真是 grok，两道门与模式此刻也得开着。
  const node = loadNode(context.database, approval.nodeId);
  if (
    record === undefined ||
    node?.agentId === undefined ||
    node.agentId === null ||
    baseAgent(context.settings, node.agentId) !== "grok"
  ) {
    return { ok: false, reason: "not_grok" };
  }
  // 模式与版本都按这个会话的 grok 进程认：现读 argv，不是节点上声明的。
  const gate = await cardAnswerGate({
    setting: context.settings.answerCards?.("grok"),
    launch: () =>
      sources.get(approval.nodeId)?.launch(record.sessionId) ?? {
        mode: undefined,
        exe: undefined,
        exact: false,
      },
    declared: () => nodePermissionMode(context.database, approval.nodeId),
  });
  if (!gate.open) return { ok: false, reason: "gate_closed" };
  const terminals = context.terminals;
  const session = loadSession(context.database, approval.nodeId);
  if (
    terminals === undefined ||
    session === undefined ||
    terminals.inputRevision === undefined
  ) {
    return { ok: false, reason: "no_terminal" };
  }
  const generation = terminals.generation(session.sessionId);
  if (generation === undefined) return { ok: false, reason: "no_terminal" };

  // 先让槽读一次文件：核对的是现在，不是上一次轮询。
  refreshNodeState(approval.nodeId);
  const source = sources.get(approval.nodeId);
  if (!sameRequest(source, record))
    return { ok: false, reason: "card_changed" };
  const before = terminals.inputRevision(session.sessionId);
  if (before === undefined) return { ok: false, reason: "no_terminal" };

  let screen: string;
  try {
    screen = (await terminals.capture(session.sessionId, 60, false)).data;
  } catch {
    return { ok: false, reason: "no_terminal" };
  }
  const card = parseGrokApprovalCard(screen);
  if (card === undefined) return { ok: false, reason: "card_unrecognized" };
  if (card.hash !== record.hash) return { ok: false, reason: "card_changed" };
  const key = grokCardKey(card, decision);
  if (key === undefined) return { ok: false, reason: "card_unrecognized" };

  // 抓屏是异步的：回来之后同步再核一遍，之后到发键之间没有 await。
  refreshNodeState(approval.nodeId);
  if (!sameRequest(sources.get(approval.nodeId), record)) {
    return { ok: false, reason: "card_changed" };
  }
  if (terminals.inputRevision(session.sessionId) !== before) {
    return { ok: false, reason: "input_changed" };
  }
  return { ok: true, key, sessionId: session.sessionId, generation, record };
}

/** 发完之后最多等这么久读到那条 resolved。 */
export const GROK_CONFIRM_MS = 2000;
const POLL_MS = 100;

/**
 * 核对通过的键写进终端，再等文件里的 resolved。决定对不上或等不到都只报，不重发
 * （重发会把数字打进下一张卡或输入栏）。
 */
export async function deliverGrokAnswer(
  context: CollabContext,
  approval: AgentApproval,
  decision: string,
  clock: {
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
  } = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  },
): Promise<
  | { readonly sent: true; readonly delivery: GrokDelivery }
  | { readonly sent: false; readonly reason: GrokRefusal }
> {
  const checked = await verifyGrokCard(context, approval, decision);
  if (!checked.ok) return { sent: false, reason: checked.reason };
  const terminals = context.terminals;
  if (terminals === undefined) return { sent: false, reason: "no_terminal" };
  try {
    await terminals.write(checked.sessionId, checked.generation, checked.key);
  } catch {
    return { sent: false, reason: "no_terminal" };
  }
  const { sessionId, offset } = checked.record;
  const deadline = clock.now() + GROK_CONFIRM_MS;
  for (;;) {
    refreshNodeState(approval.nodeId);
    const outcome =
      sources.get(approval.nodeId)?.outcomeAfter(sessionId, offset) ??
      "unknown";
    if (outcome === decision) return { sent: true, delivery: "confirmed" };
    if (outcome === "allow" || outcome === "deny") {
      return { sent: true, delivery: "mismatch" };
    }
    if (outcome === "ambiguous") return { sent: true, delivery: "ambiguous" };
    if (clock.now() >= deadline) return { sent: true, delivery: "unconfirmed" };
    await clock.sleep(POLL_MS);
  }
}
