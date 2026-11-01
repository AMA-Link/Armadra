/**
 * 手机 App 发起的设备码登录在这里批准完之后，把人带回 App 的深链（#666）。不带任何参数或
 * 秘密：App 收到它只是回到前台、立刻问一次批准结果（`armadra://cloud/device-approved`，
 * 原生不写 `#link=`、不重载）。
 */
export const APP_RETURN_URL = "armadra://cloud/device-approved";

/** 发起设备是手机 App（`auth.deviceGet` 的 `platform`）。 */
export function isMobilePlatform(platform: string): boolean {
  return platform === "ios" || platform === "android";
}

/** 跳回 App。系统可能拦掉自动跳转（没有用户手势），所以页面另有按钮指向同一个链接。 */
export function returnToApp(): void {
  globalThis.location.assign(APP_RETURN_URL);
}
