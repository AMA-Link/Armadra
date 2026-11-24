-- PR 快照（契约 §115，Issue #988）。
--
-- 每个 PR 一行：平台读到的最近一份状态、评审结论、检查、可合并性与父 PR。
-- `snapshot_json` 是 `ForgePullSnapshot`，不含 PR 正文与评论原文；`fingerprint` 是
-- 去掉读取时刻后的稳定串，用来判断「变没变」；`stale` 读时再算，不落库。
CREATE TABLE pull_snapshots (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  failed_at INTEGER,
  PRIMARY KEY (repo, number)
);
