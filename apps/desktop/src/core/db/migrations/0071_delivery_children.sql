-- 交付状态的子任务阶段（Refs #995）：只加列与索引。
--
-- done_at：agent 最近一次进入 done 的时刻（RFC 3339），「这一批」子任务以此为界；
-- NULL = 从未进入 done。
ALTER TABLE agent_status ADD COLUMN done_at TEXT;
CREATE INDEX workflow_task_runs_coordinator_status ON workflow_task_runs(coordinator_node_id, status);
