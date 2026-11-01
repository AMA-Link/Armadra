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
 *   * pi：不报，没有任何模式；
 *   * ama：`default` / `auto-edit` / `full-auto` / `plan`，id 就是 Armadra 的名字。
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
  pi: {
    default: NONE,
    "auto-edit": null,
    "full-auto": null,
    plan: null,
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
};

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
