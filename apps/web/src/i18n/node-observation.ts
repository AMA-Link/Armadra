import type { MessageModule } from "./index";

const zh = {
  "nodeObservation.open": "节点与进度",
  "nodeObservation.close": "关闭节点与进度",
  "nodeObservation.back": "返回节点列表",
  "nodeObservation.locate": "定位节点",
  "nodeObservation.empty": "这张画布还没有节点",
  "nodeObservation.count": "{count} 个节点",
  "nodeObservation.unknown": "状态未知",
  "nodeObservation.stopped": "会话已结束",
  "nodeObservation.notStarted": "尚未启动",
  "nodeObservation.lastUpdate": "最近更新",
  "nodeObservation.status": "当前状态",
  "nodeObservation.turnEnded": "本轮结束",
  "nodeObservation.waiting": "等待中",
  "nodeObservation.blocked": "受阻",
  "nodeObservation.failed": "本轮失败",
  "nodeObservation.group": "所在分组",
} as const;

const en: Record<keyof typeof zh, string> = {
  "nodeObservation.open": "Nodes and progress",
  "nodeObservation.close": "Close nodes and progress",
  "nodeObservation.back": "Back to nodes",
  "nodeObservation.locate": "Locate node",
  "nodeObservation.empty": "No nodes on this canvas yet",
  "nodeObservation.count": "{count} nodes",
  "nodeObservation.unknown": "Status unknown",
  "nodeObservation.stopped": "Session ended",
  "nodeObservation.notStarted": "Not started",
  "nodeObservation.lastUpdate": "Last updated",
  "nodeObservation.status": "Current status",
  "nodeObservation.turnEnded": "Turn ended",
  "nodeObservation.waiting": "Waiting",
  "nodeObservation.blocked": "Blocked",
  "nodeObservation.failed": "Turn failed",
  "nodeObservation.group": "Group",
};

export const nodeObservation: MessageModule = { "zh-CN": zh, en };
