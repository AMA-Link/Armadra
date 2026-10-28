import type { GuestShare } from "./relay-vault";
import type { RelayedStatus } from "./relayed-entry";

/**
 * 这张页面是经中继进的一台主机（个人中转托管页 `/app/` 或控制台 `/h/`）：页面背后
 * 没有本机 core，本机源就是那台主机。界面只问这几样——是不是这种页面、当前主机的
 * 状态（中继停了、主机下线）、是不是访客——不关心会话从哪来。
 */
export interface RelayedPage {
  /** 远程服务的签发方（页面自己的来源）。 */
  readonly issuer: string;
  readonly status: RelayedStatus;
  subscribe(listener: () => void): () => void;
  /** 按分享链接进来的访客：那份分享；账号身份是 `null`。 */
  guest(): GuestShare | null;
}

let page: RelayedPage | null = null;

/** 页面上那一个（入口装上）；桌面窗口、服务器壳、手机是 `null`。 */
export function relayedPage(): RelayedPage | null {
  return page;
}

export function setRelayedPage(next: RelayedPage | null): void {
  page = next;
}
