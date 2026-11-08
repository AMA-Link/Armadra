import { catalogProvider } from "../models/agents";
import type { Catalog } from "../models/catalog";
import { modelsDomain } from "../models";

/**
 * 目标模型的上下文容量（契约 §39.8），给交接包的 token 预算用。
 *
 * 只读 models.dev 目录那份**已经在内存里**的数据（`CatalogService.current()`，
 * 从不抓取，没有新增外呼）：目录里查得到这个模型就有容量，查不到——别名
 * （`sonnet`）、目录没收的模型、目录还没装——就是 `undefined`，交接保持字节预算
 * 并留 `tokenBudgetUnavailable`。不猜。
 */

/** 一个 token 约几个 UTF-8 字节：偏保守（中文约 1.5 字 / token，每字 3 字节）。 */
export const BYTES_PER_TOKEN = 3;

export interface ModelCapacity {
  readonly capacityTokens: number;
  /** 留给目标自己的系统提示、工具、推理与回复。 */
  readonly reservedTokens: number;
  /** 交接材料最多能占的 token。 */
  readonly availableTokens: number;
}

let source: () => Catalog | undefined = () => modelsDomain()?.catalog.current();

/** 仅测试用：换掉目录的来源；不传则恢复。 */
export function setCapacityCatalogForTest(next?: () => Catalog | undefined) {
  source = next ?? (() => modelsDomain()?.catalog.current());
}

/** Claude 的 `[1m]` 后缀：显式要 100 万上下文的那一档。 */
const SUFFIX = /\[(\d+)m\]$/i;

/**
 * 保留：输出上限与四分之一容量取大，但不超过一半——容量小的模型也要给交接材料
 * 留下一半。
 */
export function reservedFor(capacity: number, output: number | undefined) {
  return Math.min(
    Math.floor(capacity / 2),
    Math.max(output ?? 0, Math.ceil(capacity / 4)),
  );
}

export function modelCapacity(
  provider: string,
  modelId: string | null,
): ModelCapacity | undefined {
  if (modelId === null || modelId === "") return undefined;
  const catalog = source();
  if (catalog === undefined) return undefined;
  const suffix = SUFFIX.exec(modelId);
  const bare = (suffix === null ? modelId : modelId.slice(0, suffix.index))
    .trim()
    .toLowerCase();
  const wanted = catalogProvider(provider);
  const matches = catalog.models.filter(
    (model) =>
      model.modelId.toLowerCase() === bare &&
      (wanted === undefined || model.provider === wanted) &&
      model.limit.context !== undefined,
  );
  if (matches.length === 0) return undefined;
  // 没有 provider 约束时，同名模型在几家的上限可能不同：取最小的，宁紧勿松。
  const best = matches.reduce((left, right) =>
    (right.limit.context ?? 0) < (left.limit.context ?? 0) ? right : left,
  );
  const explicit = suffix === null ? undefined : Number(suffix[1]) * 1_000_000;
  const capacityTokens = explicit ?? best.limit.context ?? 0;
  if (!Number.isInteger(capacityTokens) || capacityTokens <= 0) {
    return undefined;
  }
  const reservedTokens = reservedFor(capacityTokens, best.limit.output);
  return {
    capacityTokens,
    reservedTokens,
    availableTokens: capacityTokens - reservedTokens,
  };
}
