-- 工作项账本（契约 §90，#682）：`workflow_task_runs` 原地扩列，只加列。
-- 协调者分派出去的每件事（runner 起的任务、`canvas_team` 的成员、
-- `open-agent --task-id`）就是这张表的一行。
--
-- title          一行标题，派发时给出，不超过 80 字。
-- origin_json    来源 `{ kind, ref, text? }`，kind 是 human / inbox / schedule / external。
-- mandate_json   授权 `{ by, basis, scope, at }`，派发时写入，之后不可改。
-- report_json    成员最近一次 `canvas report` 的 `{ state, summary, at }`。
-- reports_json   报告历史（含最近一次，最早的在前，最多 20 条）。
-- attention_json 待人决定的问题，单槽 `{ question, raisedAt }`。
-- handback_json  成员交回协调者的记录 `{ reason, at }`，每条只能交回一次。
-- stage          阶段函数 `itemStage()` 的结果缓存，只供查询与排序，以函数为准。
ALTER TABLE workflow_task_runs ADD COLUMN title TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN origin_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN mandate_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN report_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN reports_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN attention_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN handback_json TEXT;
ALTER TABLE workflow_task_runs ADD COLUMN stage TEXT;
