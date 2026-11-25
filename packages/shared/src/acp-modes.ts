import { AGENT_IDS, type BuiltinAgentId } from "./agents.js";
import { PERMISSION_MODES, type PermissionMode } from "./domain/primitives.js";

/**
 * ACP 下各家 Agent 的权限模式兼容表（AMA-Link/Armadra#685）。
 *
 * 一处写清「Armadra 的四个权限模式 → 这家 ACP 入口的落点」：core 的适配器表用它起
 * 会话与 `session/set_mode`，页面用它在 Agent 还没报回 `modes` 时给出候选，不在界面
 * 里按 Agent 写分支。`null` 表示这家在 ACP 下没有这个模式。
 *
 * 落点有两种：`modeId` 是 `session/set_mode` 的 id（会话里随时能切），`args` 是启动
 * argv（只在起会话时生效）。只有带 `modeId` 的模式能当会话里的候选。
 *
 * 各家在 `session/new` 答复里报的 `modes`（`availableModes` / `currentModeId`），按设计文档
 * 与适配器文档记，未逐家真跑核实：
 *   * claude：`default` / `acceptEdits` / `plan` / `bypassPermissions`；
 *   * codex：`read-only` / `workspace-write` / `agent` / `agent-full-access`；
 *   * opencode：agent 名 `build` / `plan`，没有 auto-edit / full-auto；
 *   * omp：`default` / `plan`，`write` / `yolo` 只能走启动旗标；
 *   * copilot：不报，三个模式都只能走启动旗标；
 *   * pi：ama 的桥（`--bridge pi`）用审批闸实现四个模式，id 与 ama 相同；推理强度
 *     只以 `thought_level` 配置项给出，不进 `modes`；
 *   * ama：`default` / `auto-edit` / `full-auto` / `plan`，id 就是 Armadra 的名字；
 *   * agy：`default` / `accept-edits` / `auto` / `plan`（实跑核实，2026-11-24）。
 * 各家都可能晚报或不报；Agent 报了以它为准，这张表只在报回之前顶上。
 */

/** 一个权限模式在 ACP 下的落点：`session/set_mode` 的 id、启动 argv，或两者。 */
export interface AcpModeMapping {
  readonly modeId?: string;
  readonly args?: readonly string[];
}

export type AcpModeTable = Readonly<
  Record<PermissionMode, AcpModeMapping | null>
>;

const NONE: AcpModeMapping = {};

export const ACP_MODE_TABLE: Readonly<Record<BuiltinAgentId, AcpModeTable>> = {
  claude: {
    default: { modeId: "default" },
    "auto-edit": { modeId: "acceptEdits" },
    "full-auto": { modeId: "bypassPermissions" },
    plan: { modeId: "plan" },
  },
  codex: {
    default: { modeId: "workspace-write" },
    "auto-edit": { modeId: "agent" },
    "full-auto": { modeId: "agent-full-access" },
    plan: { modeId: "read-only" },
  },
  opencode: {
    default: { modeId: "build" },
    "auto-edit": null,
    "full-auto": null,
    plan: { modeId: "plan" },
  },
  // ama 的 pi 桥：模式 id 与 ama 相同，由桥里的审批闸逐次执行。
  pi: {
    default: { modeId: "default" },
    "auto-edit": { modeId: "auto-edit" },
    "full-auto": { modeId: "full-auto" },
    plan: { modeId: "plan" },
  },
  omp: {
    default: { modeId: "default" },
    "auto-edit": { args: ["--approval-mode", "write"] },
    "full-auto": { args: ["--approval-mode", "yolo"] },
    plan: { modeId: "plan" },
  },
  // 三条旗标在 `--acp` 下是否生效待真跑核实（G3-7）。
  copilot: {
    default: NONE,
    "auto-edit": { args: ["--allow-tool=write"] },
    "full-auto": { args: ["--allow-all-tools"] },
    plan: { args: ["--plan"] },
  },
  // 模式 id 就是 ama 的权限模式（`@armadra/agent` docs/acp.md）。
  ama: {
    default: { modeId: "default" },
    "auto-edit": { modeId: "auto-edit" },
    "full-auto": { modeId: "full-auto" },
    plan: { modeId: "plan" },
  },
  // 实跑核实（agy 1.5.16，2026-11-24）：`session/new` 报 `default` /
  // `accept-edits` / `auto` / `plan` 四个，`set_mode` 都接受。`auto` 是「批准编辑与
  // 安全命令、不可逆操作仍问」，不是免审批，所以 `full-auto` 没有 modeId，走启动
  // 旗标。接回（`session/load`）后 `currentModeId` 回到 `default`，要重设。
  agy: {
    default: { modeId: "default" },
    "auto-edit": { modeId: "accept-edits" },
    "full-auto": { args: ["--dangerously-skip-permissions"] },
    plan: { modeId: "plan" },
  },
  // grok 1.0.92 真账号实测：`session/set_mode` 只认 `default` / `ask` / `plan` /
  // `agent`（agent 角色，不是权限）；`plan` 之后回 `default` 或 `agent` 都发
  // `current_mode_update`。`acceptEdits`、`auto`、`dontAsk`、`bypassPermissions`
  // 都是 `unknown mode id`，所以 auto-edit 在 ACP 下没有落点。全自动只能用启动旗标
  // `--always-approve`（`_meta.yoloMode` 要等 armadra-agent 的会话 `_meta`
  // 通道，到时再换成它，就能在会话里切）。
  //
  // plan 也暂时没有落点：grok 在 ACP 的 plan 里提交计划走客户端请求
  // `_x.ai/exit_plan_mode`，Armadra 还不会应答（armadra-agent#332 加回调，
  // Armadra#1021 做计划审批），回合会以 cancelled 结束。
  grok: {
    default: { modeId: "default" },
    "auto-edit": null,
    "full-auto": { args: ["--always-approve"] },
    plan: null,
  },
};

/**
 * 这家在 `session/new` 答复里报的 `modes` 是不是权限模式：`permission` 照常当模式
 * 用；`ignore` 是这家把别的东西（如推理强度）塞在 `modes` 里，core 丢掉它，
 * 页面不画模式选择器，那一项只以配置项出现。
 */
export type AcpReportedModes = "permission" | "ignore" | "table";

export const ACP_REPORTED_MODES: Readonly<
  Record<BuiltinAgentId, AcpReportedModes>
> = {
  claude: "permission",
  codex: "permission",
  opencode: "permission",
  pi: "permission",
  omp: "permission",
  copilot: "permission",
  ama: "permission",
  agy: "permission",
  // grok 的 `session/new|load|resume` 根本不返回 `modes`（1.0.92 真账号实测），
  // 但 `session/set_mode` 认 `default`（plan 暂不放，见兼容表）。所以模式目录以表为准（`table`）：
  // core 用 {@link acpTableModes} 当目录，agent 报来的（若哪个版本开始报，那是
  // agent 角色 `default/ask/plan/agent`，不是权限）一律不用。
  grok: "table",
};

/**
 * 这家的模式目录从哪来：`permission` 用 agent 报来的 `modes`；`ignore` 没有模式
 * 选择器；`table` 忽略 agent 报的，用兼容表（{@link acpTableModes}）。不认识的
 * Agent 按 `permission`。
 */
export function acpModeSource(agentId: string): AcpReportedModes {
  return (AGENT_IDS as readonly string[]).includes(agentId)
    ? ACP_REPORTED_MODES[agentId as BuiltinAgentId]
    : "permission";
}

/** 这家报的 `modes` 要不要当权限模式；不认识的 Agent 按权限模式。 */
export function acpReportsPermissionModes(agentId: string): boolean {
  return (
    !(AGENT_IDS as readonly string[]).includes(agentId) ||
    ACP_REPORTED_MODES[agentId as BuiltinAgentId] === "permission"
  );
}

function tableOf(agentId: string): AcpModeTable | undefined {
  return (AGENT_IDS as readonly string[]).includes(agentId)
    ? ACP_MODE_TABLE[agentId as BuiltinAgentId]
    : undefined;
}

/** 会话里能切的候选：`permissionMode` 与它在这家的 `session/set_mode` id。 */
export interface AcpModeCandidate {
  readonly permissionMode: PermissionMode;
  readonly modeId: string;
}

/**
 * 这家在会话里能切的权限模式（带 `modeId` 的那些，含 bypass 一类的全自动）。
 * 不认识的 Agent（自定义条目要先换成它的基础 CLI）、没有模式的家答空。
 */
export function acpModeCandidates(
  agentId: string,
): readonly AcpModeCandidate[] {
  const table = tableOf(agentId);
  if (table === undefined) return [];
  const out: AcpModeCandidate[] = [];
  for (const permissionMode of PERMISSION_MODES) {
    const modeId = table[permissionMode]?.modeId;
    if (modeId !== undefined) out.push({ permissionMode, modeId });
  }
  return out;
}

/**
 * `table` 家的模式目录：兼容表里带 `modeId` 的那些，按权限模式的顺序。形状与
 * `session/new` 答复里的 `modes.availableModes` 一致，core 当 agent 报来的用。
 */
export function acpTableModes(
  agentId: string,
): readonly { readonly id: string; readonly name: string }[] {
  return acpModeCandidates(agentId).map((candidate) => ({
    id: candidate.modeId,
    name: candidate.modeId,
  }));
}

/**
 * 终端有旗标、ACP 下确实没有落点的权限模式（表里显式为 `null`），逐家写明理由：
 *   * grok：终端 `--permission-mode acceptEdits` 存在，但 ACP 的 `session/set_mode`
 *     只认 `default` / `ask` / `plan` / `agent`（agent 角色，不是权限）——1.0.92
 *     真账号逐个 id 实测，`acceptEdits` 报 `unknown mode id`；ACP 也没有别的入口。
 *     界面按「这家 ACP 没有这个模式」处理，与设置页只给有对应参数的权限模式同一规矩。
 * 测试「终端有旗标的模式在 ACP 下必须有落点」只放行这里列出的。
 */
export const NO_ACP_LANDING: Readonly<
  Partial<Record<BuiltinAgentId, readonly PermissionMode[]>>
> = {
  // plan：见上面兼容表，等 Armadra#1021（`_x.ai/exit_plan_mode` 计划审批）。
  grok: ["auto-edit", "plan"],
};

/** 权限模式 → 这家的 `session/set_mode` id；没有落点答 `undefined`。 */
export function acpModeIdOf(
  agentId: string,
  permissionMode: PermissionMode,
): string | undefined {
  return tableOf(agentId)?.[permissionMode]?.modeId;
}

/** `session/set_mode` id → 权限模式；对不上答 `undefined`。 */
export function permissionModeOfAcpMode(
  agentId: string,
  modeId: string,
): PermissionMode | undefined {
  return acpModeCandidates(agentId).find(
    (candidate) => candidate.modeId === modeId,
  )?.permissionMode;
}
