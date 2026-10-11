/**
 * 暂时下线的功能开关（#295）。
 *
 * 这里是唯一的开关：页面（设置导航、新建菜单、命令面板、工作面板）、core 的
 * 调度循环与桌面托盘都读这一张表。改回 `true` 即恢复，不用动别处。
 *
 * 关掉只是**不露入口**：代码、数据库里的数据与 `/api/*` 接口都保留；已保存
 * 画布里的计划卡片与活动卡片照常加载。
 */
export type FeatureFlag =
  /** 设置 → 凭据与密钥。 */
  | "credentials"
  /** 设置 → 用量与额度、工具簇用量胶囊与抽屉、托盘用量读数。 */
  | "usage"
  /** 新建菜单里的「活动卡片」。 */
  | "activityCards"
  /** 定时计划：新建菜单、自动化抽屉、手机底部导航，以及 core 的调度循环。 */
  | "scheduledTasks"
  /** 工作流：新建菜单、工作流抽屉、协调者草案卡。 */
  | "workflows";

export const FEATURE_FLAGS: Readonly<Record<FeatureFlag, boolean>> = {
  credentials: false,
  usage: false,
  activityCards: false,
  scheduledTasks: false,
  workflows: false,
};

export function featureEnabled(
  flag: FeatureFlag,
  flags: Readonly<Record<FeatureFlag, boolean>> = FEATURE_FLAGS,
): boolean {
  return flags[flag] === true;
}
