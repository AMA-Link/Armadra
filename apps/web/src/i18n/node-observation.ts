import type { MessageModule } from "./index";

const zh = {
  "nodeObservation.open": "节点与进度",
  "nodeObservation.close": "关闭节点与进度",
  "nodeObservation.back": "返回节点列表",
  "nodeObservation.locate": "定位节点",
  "nodeObservation.empty": "这张画布还没有节点",
  "nodeObservation.count": "{count} 个节点",
  "nodeObservation.lastUpdate": "最近更新",
  "nodeObservation.group": "所在分组",
} as const;

const en: Record<keyof typeof zh, string> = {
  "nodeObservation.open": "Nodes and progress",
  "nodeObservation.close": "Close nodes and progress",
  "nodeObservation.back": "Back to nodes",
  "nodeObservation.locate": "Locate node",
  "nodeObservation.empty": "No nodes on this canvas yet",
  "nodeObservation.count": "{count} nodes",
  "nodeObservation.lastUpdate": "Last updated",
  "nodeObservation.group": "Group",
};

export const nodeObservation: MessageModule = { "zh-CN": zh, en };
