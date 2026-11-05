-- 工作项绑定 PR（契约 §103，#705，R4 第一阶段）。
-- workflow_task_runs.threads
--                   工作项绑定的外部线程（JSON 数组），元素形如
--                   `{ kind: "pull", repo, number, own, url, boundAt }`；空表示没绑。
--                   `own` 是这个工作项自己开的 PR（全部合并或关闭后这一项结束）。
--
-- thread_events     轮询读到的外部事件的账：同一个事件 id 只记一次，重复读到什么都不做。
-- item_id           工作项（`workflow_task_runs.task_id`）。
-- event_id          确定的：`pr-comment:<仓库>#<编号>:<评论 id>` /
--                   `pr-review:…` / `pr-checks:<仓库>#<编号>:<sha>:<结论>` /
--                   `pr-state:<仓库>#<编号>:<merged|closed>`。
-- repo / number     线程，与 threads 里的一致。
-- kind              comment / review / checks / state。
-- actor             评论者的登录名（机器人评论计「每个 PR 每个机器人最多 3 轮」用）；
--                   其余为空。
-- delivered         1 = 投给了成员；0 = 只记账（机器人超过 3 轮）。
-- source_at         事件在远端发生的时刻（毫秒）：轮询游标取同一线程里它的最大值。
-- seen_at           读到的时刻（毫秒）。
ALTER TABLE workflow_task_runs ADD COLUMN threads TEXT;

CREATE TABLE thread_events (
  item_id TEXT NOT NULL REFERENCES workflow_task_runs(task_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 300),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  delivered INTEGER NOT NULL DEFAULT 1,
  source_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, event_id)
);
CREATE INDEX thread_events_pull ON thread_events(item_id, repo, number, kind);
