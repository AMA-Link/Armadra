/**
 * 提示框里模式、模型与上下文余量的取舍（AMA-Link/Armadra#685）。
 *
 * 各家 Agent 报 `modes` / `models` 的早晚不一（有的要等首条消息之后，有的不报）。
 * 这里把「报了用它报的，没报用已知候选」收在纯函数里，界面只认结果，不按 Agent
 * 写分支：模式候选来自 `@armadra/shared` 的 `ACP_MODE_TABLE`（含 bypass 一类的全自动），
 * 模型候选来自节点的 `agent.model` 与该 CLI 的内置建议。
 */
import {
  acpModeCandidates,
  acpModeIdOf,
  modelSuggestions,
  type AcpModeState,
  type AcpModelState,
  type PermissionMode,
  type TimelineConfigOption,
  type TimelineItem,
} from "@armadra/shared";

/** 还没有真实目录时「用 CLI 自己的默认模型」那一项；永远不发给 Agent。 */
export const DEFAULT_MODEL_ID = "__default";

/** 提示框的候选模式：Agent 报回之前顶上；这家在会话里没有可切的模式答 `null`。 */
export function candidateModes(
  baseAgent: string,
  permissionMode: PermissionMode | undefined,
  nameOf: (mode: PermissionMode) => string,
): AcpModeState | null {
  const candidates = acpModeCandidates(baseAgent);
  const first = candidates[0];
  if (first === undefined) return null;
  const current =
    acpModeIdOf(baseAgent, permissionMode ?? "default") ?? first.modeId;
  return {
    currentModeId: current,
    availableModes: candidates.map((candidate) => ({
      id: candidate.modeId,
      name: nameOf(candidate.permissionMode),
    })),
  };
}

/** 候选模型：默认项、节点上记的模型、该 CLI 的内置建议，去重。 */
export function candidateModels(
  baseAgent: string,
  model: string | undefined,
  defaultName: string,
): AcpModelState {
  const ids = [
    ...new Set([...(model ? [model] : []), ...modelSuggestions(baseAgent)]),
  ];
  return {
    currentModelId: model ? model : DEFAULT_MODEL_ID,
    availableModels: [
      { modelId: DEFAULT_MODEL_ID, name: defaultName },
      ...ids.map((id) => ({ modelId: id, name: id })),
    ],
  };
}

/** Agent 报回的目录优先；没报用候选。选中的项在目录里才算数。 */
export function pickModes(
  reported: AcpModeState | null,
  candidates: AcpModeState | null,
  choice: string | null,
): AcpModeState | null {
  const base = reported ?? candidates;
  if (base === null) return null;
  return choice !== null && base.availableModes.some((m) => m.id === choice)
    ? { ...base, currentModeId: choice }
    : base;
}

export function pickModels(
  reported: AcpModelState | null,
  candidates: AcpModelState,
  choice: string | null,
): AcpModelState {
  const base = reported ?? candidates;
  return choice !== null &&
    base.availableModels.some((m) => m.modelId === choice)
    ? { ...base, currentModelId: choice }
    : base;
}

/**
 * 提示框里除模型与模式之外要画的配置项（推理强度、其他 select、boolean）。模型与
 * 模式另有各自的选择器，按 `category`（模型项没有分类时按 id `model`）认出来排除。
 * `choices` 是还没等到回执的选择（乐观更新）；值不合项的类型或可选值就不采用。
 */
export function extraConfigOptions(
  options: readonly TimelineConfigOption[] | null | undefined,
  choices: Readonly<Record<string, string | boolean>> = {},
): TimelineConfigOption[] {
  return (options ?? [])
    .filter(
      (option) =>
        option.category !== "model" &&
        option.category !== "mode" &&
        !(option.category === undefined && option.id === "model") &&
        (option.type === "boolean" || option.options.length > 0),
    )
    .map((option) => {
      const choice = choices[option.id];
      const valid =
        choice !== undefined &&
        (option.type === "boolean"
          ? typeof choice === "boolean"
          : typeof choice === "string" &&
            option.options.some((entry) => entry.value === choice));
      return valid ? { ...option, currentValue: choice } : option;
    });
}

/**
 * 首条消息发出去了没有：core 回显了一条用户条目（Agent 收到了），而且它的回合没有
 * 以错误收场。页面自己先画的提问、被拒或没送达的都不在 `items` 里，所以不算。
 */
export function firstMessageSent(items: readonly TimelineItem[]): boolean {
  const failed = new Set<number>();
  for (const item of items) {
    if (item.kind === "turn" && item.error !== undefined) failed.add(item.turn);
  }
  return items.some((item) => item.kind === "user" && !failed.has(item.turn));
}

/** 上下文余量只在首条消息成功发出之后显示。 */
export function visibleUsage<T>(
  usage: T | null | undefined,
  items: readonly TimelineItem[],
): T | null {
  return usage != null && firstMessageSent(items) ? usage : null;
}
