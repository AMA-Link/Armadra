import { FEATURE_FLAGS, type FeatureFlag } from "@armadra/shared";

/**
 * 页面这一侧读功能开关的地方（#295）。开关本身在
 * `packages/shared/src/feature-flags.ts`，这里只做页面要的几样换算。
 */
export type { FeatureFlag };

export function featureEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag] === true;
}

/** 工作面板 → 它所属的功能；不在表里的面板不受开关影响。 */
const PANEL_FEATURES: Readonly<Record<string, FeatureFlag>> = {
  automation: "scheduledTasks",
  workflow: "workflows",
  usage: "usage",
};

/** 这块面板所属的功能关着：任何入口都不该把它打开。 */
export function panelHidden(panel: string): boolean {
  const flag = PANEL_FEATURES[panel];
  return flag !== undefined && !featureEnabled(flag);
}
