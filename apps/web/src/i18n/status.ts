import type { MessageModule } from "./index";

/**
 * 统一状态显示的文案（共享层 `sessionDisplay()` 的 `labelKey`）。
 * 节点头胶囊、侧栏、抽屉、通知面板都用这一套，同一个状态只有一种说法。
 */
const zh = {
  "status.starting": "启动中",
  "status.restoring": "恢复历史",
  "status.idle": "空闲",
  "status.submitting": "提交中",
  "status.thinking": "思考中",
  "status.tool": "调用工具",
  "status.awaitingApproval": "等待审批",
  "status.awaitingInput": "等待回答",
  "status.responding": "输出中",
  "status.switching": "切换中",
  "status.sleeping": "已休眠",
  "status.exited": "已退出",
  "status.working": "运行中",
  "status.unknown": "状态未知",
  "status.done": "已完成",
  "status.failed": "已失败",
  "status.refused": "被拒绝",
  "status.interrupted": "已暂停",
  "status.limit": "达到上限",
  "state.loading": "加载中",
  "state.error": "没能加载",
  "state.retry": "重试",
} as const;

const en: Record<keyof typeof zh, string> = {
  "status.starting": "Starting",
  "status.restoring": "Restoring history",
  "status.idle": "Idle",
  "status.submitting": "Submitting",
  "status.thinking": "Thinking",
  "status.tool": "Running a tool",
  "status.awaitingApproval": "Awaiting approval",
  "status.awaitingInput": "Awaiting an answer",
  "status.responding": "Responding",
  "status.switching": "Switching",
  "status.sleeping": "Asleep",
  "status.exited": "Exited",
  "status.working": "Running",
  "status.unknown": "Status unknown",
  "status.done": "Done",
  "status.failed": "Turn failed",
  "status.refused": "Refused",
  "status.interrupted": "Paused",
  "status.limit": "Limit reached",
  "state.loading": "Loading",
  "state.error": "Couldn't load",
  "state.retry": "Retry",
};

export const status: MessageModule = { "zh-CN": zh, en };
