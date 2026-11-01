/**
 * 按模型选择（契约 §26.2）：Agent 在会话配置项里给的模型目录。
 *
 * ACP 的会话配置项（`configOptions`）随 `session/new|load|resume` 的答复来，
 * 也可能先在 `initialize` 的答复里；之后 Agent 以 `config_option_update` 更新、
 * 客户端以 `session/set_config_option` 改。模型那一项按 `category: "model"`
 * 认，没有分类时按 id `model` 认；都没有就是这家不给选模型。
 *
 * 纯函数，不起进程、不碰客户端。
 */

import {
  configOptionsViewOf,
  type TimelineConfigOption,
} from "@armadra/shared";

import type {
  AcpConfigSelectGroup,
  AcpConfigSelectOption,
  AcpSessionConfigOption,
  AcpSessionModeState,
} from "./types";

export interface AcpModel {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | null;
}

/** 页面看到的模型目录（与 `modes` 同一个形状）。 */
export interface AcpModelState {
  readonly currentModelId: string;
  readonly availableModels: readonly AcpModel[];
}

/** core 自己多记的那一项：改模型时发给 Agent 的配置项 id。 */
export interface AcpModelCatalog extends AcpModelState {
  readonly configId: string;
}

/** 目录的上限：只为不让一个 Agent 把答复撑大。 */
const MODEL_LIMIT = 500;

function isGroup(
  value: AcpConfigSelectOption | AcpConfigSelectGroup,
): value is AcpConfigSelectGroup {
  return Array.isArray((value as { options?: unknown }).options);
}

function flatten(
  options: readonly (AcpConfigSelectOption | AcpConfigSelectGroup)[],
): AcpConfigSelectOption[] {
  const out: AcpConfigSelectOption[] = [];
  for (const option of options) {
    if (typeof option !== "object" || option === null) continue;
    if (isGroup(option)) {
      out.push(...flatten(option.options));
    } else if (typeof option.value === "string") {
      out.push(option);
    }
  }
  return out;
}

function modelOption(
  options: readonly AcpSessionConfigOption[],
): AcpSessionConfigOption | undefined {
  const valid = options.filter(
    (option) =>
      typeof option === "object" &&
      option !== null &&
      typeof option.id === "string" &&
      Array.isArray(option.options),
  );
  return (
    valid.find((option) => option.category === "model") ??
    valid.find(
      (option) =>
        (option.category === undefined || option.category === null) &&
        option.id === "model",
    )
  );
}

/** 配置项 → 模型目录；没有模型那一项或一个可选值都没有时答 `null`。 */
export function modelCatalogOf(configOptions: unknown): AcpModelCatalog | null {
  if (!Array.isArray(configOptions)) return null;
  const option = modelOption(configOptions as AcpSessionConfigOption[]);
  if (option === undefined) return null;
  const seen = new Set<string>();
  const models: AcpModel[] = [];
  for (const entry of flatten(option.options)) {
    if (seen.has(entry.value) || models.length >= MODEL_LIMIT) continue;
    seen.add(entry.value);
    models.push({
      modelId: entry.value,
      name: typeof entry.name === "string" ? entry.name : entry.value,
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    });
  }
  if (models.length === 0) return null;
  const current =
    typeof option.currentValue === "string" && seen.has(option.currentValue)
      ? option.currentValue
      : (models[0] as AcpModel).modelId;
  return {
    configId: option.id,
    currentModelId: current,
    availableModels: models,
  };
}

/** 页面那一份（不带 `configId`）。 */
export function modelStateOf(
  catalog: AcpModelCatalog | null,
): AcpModelState | null {
  return catalog === null
    ? null
    : {
        currentModelId: catalog.currentModelId,
        availableModels: catalog.availableModels,
      };
}

/** 一个答复（开会话、改配置项、`config_option_update`）里的 `configOptions`。 */
export function configOptionsOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { configOptions?: unknown }).configOptions
    : undefined;
}

/**
 * 配置项的清洗视图（`head.configOptions`，P2-4）：select 与 boolean，分组摊平。
 * 没有可用的配置项（含不是数组）答空表。
 */
export function configViewOf(configOptions: unknown): TimelineConfigOption[] {
  return configOptionsViewOf(configOptions) ?? [];
}

/**
 * 模式以配置项给出（`category: "mode"` 的 select）时的模式表。Agent 同时给了
 * `modes` 时以 `modes` 为准，这里只在没有时顶上。
 */
export function modeStateOfConfig(
  view: readonly TimelineConfigOption[],
): { configId: string; state: AcpSessionModeState } | null {
  const option = view.find(
    (entry) => entry.category === "mode" && entry.type === "select",
  );
  if (option === undefined || typeof option.currentValue !== "string") {
    return null;
  }
  return {
    configId: option.id,
    state: {
      currentModeId: option.currentValue,
      availableModes: option.options.map((choice) => ({
        id: choice.value,
        name: choice.name,
        ...(choice.description === undefined
          ? {}
          : { description: choice.description }),
      })),
    },
  };
}

/** 改了一个配置项之后答复里没有新列表时，本地把那一项的现值改上。 */
export function withConfigValue(
  view: readonly TimelineConfigOption[],
  configId: string,
  value: string | boolean,
): TimelineConfigOption[] {
  return view.map((entry) =>
    entry.id === configId ? { ...entry, currentValue: value } : entry,
  );
}

/**
 * 页面要改的 `configId` / `value` 合不合这份配置：项在表里、类型对得上、select 的值
 * 是它给的可选值之一。合则答 `null`，不合答原因。
 */
export function configValueProblem(
  view: readonly TimelineConfigOption[],
  configId: string,
  value: unknown,
): string | null {
  const option = view.find((entry) => entry.id === configId);
  if (option === undefined) return `the agent has no config option ${configId}`;
  if (option.type === "boolean") {
    return typeof value === "boolean"
      ? null
      : `config option ${configId} takes true or false`;
  }
  return typeof value === "string" &&
    option.options.some((choice) => choice.value === value)
    ? null
    : `config option ${configId} has no value ${String(value)}`;
}
