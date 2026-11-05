-- 协调者的回复闸门（契约 §101，#704）。
-- 协调者对人说话统一走 `canvas notify`：每一条被接受的回复落这一张表，用来去重
-- （同一个 id 只能写一次）、消耗 `followup`（`answer:<followup 事件 id>`），并供页面
-- 读（分派抽屉的成员行、协调者节点头的未读点）。
--
-- id           确定的：`result:<项>:<报告时刻>` / `attention:<项>:<问题 raisedAt>` /
--              `answer:<followup 事件 id>`；同一个 id 重复写入被拒绝（409）。
-- item_id      工作项（`workflow_task_runs.task_id`）。
-- purpose      answer / result / attention。
-- stage        写入时这一项的阶段。
-- text         协调者写的一句话（1–100 字，去控制字符）。
-- created_at   毫秒。
-- read_at      人打开分派抽屉的时刻（毫秒）；空表示未读。
CREATE TABLE router_replies (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
  coordinator_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  stage TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX router_replies_item ON router_replies(coordinator_node_id, item_id, created_at);
