import {
  PUSH_PREFERENCE_KINDS,
  type PushPreferenceKind,
} from "@armadra/shared";

import { featureEnabled } from "../lib/features";

/**
 * 推送偏好里列给人看的种类（契约 §27.1）。定时任务暂时下线（#295）：它的开关
 * 不列，已存的选择原样保留。手机推送提示与设置页「推送设备」共用。
 */
export function visiblePushKinds(): PushPreferenceKind[] {
  return PUSH_PREFERENCE_KINDS.filter(
    (kind) => kind !== "schedule" || featureEnabled("scheduledTasks"),
  );
}

/** 打开或关掉一个种类之后的完整列表，按共享层的顺序。 */
export function toggledKinds(
  current: readonly PushPreferenceKind[],
  kind: PushPreferenceKind,
  on: boolean,
): PushPreferenceKind[] {
  return PUSH_PREFERENCE_KINDS.filter((item) =>
    item === kind ? on : current.includes(item),
  );
}
