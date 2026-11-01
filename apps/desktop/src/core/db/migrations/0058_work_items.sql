-- 协调者的工作项账本（#682）：`workflow_task_runs` 每一行就是一个工作项，只加列。
-- title：一行标题。origin_json：来源（谁的原话，`{ kind, ref, text }`）。
-- mandate_json：派发时定下的授权（`{ by, basis, scope, at }`），之后不改。
-- report_json：最近一次报告（`{ state, summary, at }`）。
-- attention_json：待人决定的那一个问题（单槽，`{ question, raisedAt }`），回答或清除后为 NULL。
-- 阶段不存：读的时候由这些事实推出来，存下来的阶段迟早与事实对不上。
ALTER TABLE workflow_task_runs ADD COLUMN title TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN origin_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN mandate_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN report_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN attention_json TEXT;

-- 报告与回交的历史：`items --item` 的历史从这里读。seq 按工作项递增。
CREATE TABLE workflow_task_reports (
  task_id       TEXT NOT NULL REFERENCES workflow_task_runs(task_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  -- 'report' | 'handback'
  kind          TEXT NOT NULL,
  -- report：'progress' | 'waiting' | 'ready' | 'blocked' | 'failed'；handback 为 NULL
  state         TEXT,
  summary       TEXT NOT NULL,
  human_action  TEXT,
  at            INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq)
);
