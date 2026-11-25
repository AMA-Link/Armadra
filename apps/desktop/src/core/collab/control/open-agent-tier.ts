import { amaSupportsTier } from "../../agent/launch";
import { storedProbe } from "../../agent/probe";
import { roleLaunch } from "../../workflow/tier";
import { WORKFLOW_TIERS, type WorkflowTier } from "../../workflow/types";
import type { CollabContext } from "../service";
import type { Args } from "../refusals";

/**
 * `--tier`（设计 §2.5）：`--model` 同给时模型优先、档位不起作用；ama 在探测到的
 * 版本支持时原样写 `agent.tier`；其它 CLI 只有内置别名映射（claude）且该 CLI
 * 能选模型时落成 `agent.model`。不认识的档位、查不到映射一律忽略，不报错。
 */
export function tierLaunch(
  context: CollabContext,
  agentId: string,
  args: Args,
): { model?: string; tier?: WorkflowTier } {
  const wanted = args.text("tier")?.trim();
  if (
    wanted === undefined ||
    args.text("model") !== undefined ||
    !(WORKFLOW_TIERS as readonly string[]).includes(wanted)
  ) {
    return {};
  }
  const launch = roleLaunch(
    context.settings,
    { id: "open-agent", agentId, tier: wanted as WorkflowTier },
    amaSupportsTier(storedProbe("ama")?.version ?? undefined),
  );
  if (launch.model !== null) return { model: launch.model };
  if (launch.tier !== null) return { tier: launch.tier };
  return {};
}
