-- 节点 → PR 关联（契约 §116，Issue #988）。
--
-- 画布上的 Agent 节点停在哪个分支，那个分支开着的 PR 就记在这里。一个 PR 同一时刻
-- 只归一个节点（`released_at IS NULL` 的行唯一）；节点被删、切走分支、或 PR 被工作项
-- 绑定夺走时记下 `released_at`，行留着不删。只用来刷新 PR 快照，不产生任何投递。
CREATE TABLE node_pull_links (
  node_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_ref TEXT NOT NULL,
  url TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (node_id, repo, number)
);

CREATE UNIQUE INDEX node_pull_links_owner ON node_pull_links(repo, number)
  WHERE released_at IS NULL;
CREATE INDEX node_pull_links_node ON node_pull_links(node_id)
  WHERE released_at IS NULL;
