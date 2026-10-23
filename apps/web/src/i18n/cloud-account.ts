import type { MessageModule } from "./index";

/** 云端控制台的账号文案（云端控制台 §5.2 cloud-account，M1 部分）；安全的两步验证、通知、数据与令牌（U9）接着补。 */
export const cloudAccount: MessageModule = {
  "zh-CN": {
    "cloud.overview.pending": "待处理",
    "cloud.overview.hostsOnline": "{online} / {total} 在线",
    "cloud.overview.invited": "{name} 邀请了你",
  },
  en: {
    "cloud.overview.pending": "Pending",
    "cloud.overview.hostsOnline": "{online} / {total} online",
    "cloud.overview.invited": "{name} invited you",
  },
};
