/**
 * 内存越线的判定（路线图 §4.3），给资源面板的会话表标色用。
 *
 * 提醒不在这里：越线判定与去重在 core，经 `resources.threshold` 报来，提醒与
 * 徽标的颜色由 `threshold-alerts.ts` 处理（契约 §27.4）。
 */

/**
 * 这一份样本是否越线。
 *
 * `null` 的内存永远不算越线：测不出来不是「超了」，把 unknown 当成越线会标出
 * 一个关于不存在的数字的警告。
 */
export function crossedThreshold(
  memoryBytes: number | null | undefined,
  thresholdBytes: number,
): boolean {
  return (
    typeof memoryBytes === "number" &&
    Number.isFinite(memoryBytes) &&
    memoryBytes >= thresholdBytes
  );
}
