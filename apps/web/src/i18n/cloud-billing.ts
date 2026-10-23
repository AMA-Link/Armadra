import type { MessageModule } from "./index";

/** 云端控制台的计划与用量文案（云端控制台 §5.2 cloud-billing）；个人概览先用到这一部分，用量与计划页（U6）接着补。 */
export const cloudBilling: MessageModule = {
  "zh-CN": {
    "cloud.billing.plan": "计划",
    "cloud.billing.free": "免费版",
    "cloud.billing.pro": "专业版",
    "cloud.billing.team": "团队版",
    "cloud.billing.enterprise": "企业版",
    "cloud.billing.hosts": "主机",
    "cloud.billing.traffic": "本月流量",
    "cloud.billing.of": "{used} / {limit}",
    "cloud.billing.unlimited": "不限",
    "cloud.billing.nearLimit": "接近上限",
    "cloud.billing.atLimit": "已达上限",
  },
  en: {
    "cloud.billing.plan": "Plan",
    "cloud.billing.free": "Free",
    "cloud.billing.pro": "Pro",
    "cloud.billing.team": "Team",
    "cloud.billing.enterprise": "Enterprise",
    "cloud.billing.hosts": "Hosts",
    "cloud.billing.traffic": "Traffic this month",
    "cloud.billing.of": "{used} / {limit}",
    "cloud.billing.unlimited": "Unlimited",
    "cloud.billing.nearLimit": "Near limit",
    "cloud.billing.atLimit": "Limit reached",
  },
};
