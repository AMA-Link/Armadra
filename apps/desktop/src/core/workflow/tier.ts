import { baseAgent, type AgentSettings } from "../agent/registry";
import { canSelectModel } from "../agent/launch";
import type { WorkflowDraft, WorkflowRole, WorkflowTier } from "./types";

/**
 * 角色档位到启动参数的映射（契约 §119.5）。纯函数。
 *
 * - `native`：ama 自己认 `--tier`；
 * - `mapped`：映射成该 CLI 的模型别名；
 * - `ignored`：这台机器上用不上，草案卡上提示。
 */
export type TierEffect = "native" | "mapped" | "ignored";

/** 内置映射表：只有 claude 的内置别名；其它 CLI 没有可靠的别名。 */
const TIER_MODELS: Readonly<
  Record<string, Readonly<Record<WorkflowTier, string>>>
> = {
  claude: {
    light: "haiku",
    standard: "sonnet",
    strong: "opus",
    max: "opus",
  },
};

/** `agentId` 是内置（基础）Agent id；没有内置映射就是 `undefined`。 */
export function tierModel(
  agentId: string,
  tier: WorkflowTier,
): string | undefined {
  return TIER_MODELS[agentId]?.[tier];
}

export interface RoleLaunch {
  readonly model: string | null;
  readonly tier: WorkflowTier | null;
  readonly effect: TierEffect | null;
}

/**
 * 一个角色起节点时用的模型与档位。`role.model` 非空优先、档位不起作用；
 * ama 在探测到的版本支持时原样交给 `--tier`；其它 CLI 查内置表，且该 CLI 能选模型。
 */
export function roleLaunch(
  settings: AgentSettings,
  role: WorkflowRole,
  amaSupportsTier: boolean,
): RoleLaunch {
  const model =
    role.model !== undefined && role.model !== null && role.model !== ""
      ? role.model
      : null;
  if (model !== null) return { model, tier: null, effect: null };
  const tier = role.tier ?? null;
  if (tier === null) return { model: null, tier: null, effect: null };
  const base = baseAgent(settings, role.agentId);
  if (base === "ama") {
    return amaSupportsTier
      ? { model: null, tier, effect: "native" }
      : { model: null, tier: null, effect: "ignored" };
  }
  const mapped = tierModel(base, tier);
  if (mapped !== undefined && canSelectModel(settings, role.agentId)) {
    return { model: mapped, tier: null, effect: "mapped" };
  }
  return { model: null, tier: null, effect: "ignored" };
}

/** 档位在这台机器上不起作用的角色 id（草案行的 `hints.tierIgnored`）。 */
export function tierHints(
  settings: AgentSettings,
  draft: WorkflowDraft,
  amaSupportsTier: boolean,
): readonly string[] {
  return draft.roles
    .filter(
      (role) =>
        roleLaunch(settings, role, amaSupportsTier).effect === "ignored",
    )
    .map((role) => role.id);
}
