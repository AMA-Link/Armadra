import type { MessageModule } from "./index";

/**
 * 分享链接的加入（客户端包 §6，个人中转）：设置 → 远程服务里的「通过链接加入」
 * 对话框，与远程服务托管页面上的落地页（`/j/<linkId>`）。失败的那句按错误码取
 * （`error.link*` 等，在 `errors.ts`）。
 *
 * 术语沿用 `remote.ts`：「分享链接」是别人给的那条链接，「加入」是用它挂上那台
 * 机器。落地页的标题与「在 Armadra 中打开」和中继自带的最小落地页同一句。
 */
export const links: MessageModule = {
  "zh-CN": {
    "links.join": "通过链接加入",
    "links.field": "分享链接",
    "links.action": "加入",
    "links.page.title": "加入共享",
    "links.page.openApp": "在 Armadra 中打开",
    "links.page.joinInBrowser": "在浏览器中加入",
    "links.page.invalid": "这不是一条完整的分享链接",
    "links.page.failed": "没能加入",
    "links.page.retry": "重试",
    "links.bar.shared": "他人分享",
    "links.bar.of": "{owner} 的 {name}",
    "links.bar.until": "有效至 {time}",
    "links.bar.install": "安装 Armadra",
  },
  en: {
    "links.join": "Join with link",
    "links.field": "Share link",
    "links.action": "Join",
    "links.page.title": "Join a share",
    "links.page.openApp": "Open in Armadra",
    "links.page.joinInBrowser": "Join in browser",
    "links.page.invalid": "This isn't a complete share link",
    "links.page.failed": "Couldn't join",
    "links.page.retry": "Try again",
    "links.bar.shared": "Shared with you",
    "links.bar.of": "{owner}'s {name}",
    "links.bar.until": "Until {time}",
    "links.bar.install": "Install Armadra",
  },
};
