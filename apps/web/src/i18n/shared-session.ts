import type { MessageModule } from "./index";

/**
 * 被分享会话的只读查看页（`shared-session/`，契约 §71）：会话分享的访客打开链接
 * 后落在这里；桌面侧栏「他人分享」下也列出这些会话。
 */
export const sharedSession: MessageModule = {
  "zh-CN": {
    "sharedSession.readOnly": "只读",
    "sharedSession.terminal": "终端",
    "sharedSession.session": "分享的会话",
    "sharedSession.ended": "已结束",
    "sharedSession.offline": "已断开",
    "sharedSession.close": "关闭",
    "sharedSession.failed": "没能打开这条会话",
    "sharedSession.empty": "还没有内容",
    "sharedSession.loading": "正在打开",
  },
  en: {
    "sharedSession.readOnly": "Read-only",
    "sharedSession.terminal": "Terminal",
    "sharedSession.session": "Shared session",
    "sharedSession.ended": "Ended",
    "sharedSession.offline": "Disconnected",
    "sharedSession.close": "Close",
    "sharedSession.failed": "Couldn't open this session",
    "sharedSession.empty": "Nothing here yet",
    "sharedSession.loading": "Opening",
  },
};
