-- 协调者的统一事件队列（契约 §93，#696）。
-- 报告、交回、看门狗、任务结束、人的追问、别的节点的留言，原先各走各的路到协调者；
-- 现在都先落这一张表，由 core 在协调者空闲时合并成一张卡片投递，协调者处理完
-- 用 `canvas ack --event` 确认。事件按协调者节点归属，节点删了跟着删。
--
-- id           确定的：种类 + 来源 id + 版本，同一个 id 重复写入什么都不做。
-- kind         report / attention / handback / task-done / stalled / followup / inbox。
-- item_id      相关的工作项（`workflow_task_runs.task_id`），没有就空。
-- source_node_id 说这件事的成员节点，不设外键：成员节点删了，这一行仍然要说得清。
-- summary      一行内容，只有节点名、工作项 id、成员自己写的那一行；不带终端原文。
-- created_at   毫秒。
-- carded_at    最近一次进卡片的时刻（毫秒）；没有就是还没提醒过。
-- acked_at     协调者确认「我处理了」的时刻（毫秒）；确认之后不再进卡片。
CREATE TABLE router_events (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
  coordinator_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_id TEXT,
  source_node_id TEXT,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  carded_at INTEGER,
  acked_at INTEGER
);
CREATE INDEX router_events_open ON router_events(coordinator_node_id, created_at) WHERE acked_at IS NULL;
