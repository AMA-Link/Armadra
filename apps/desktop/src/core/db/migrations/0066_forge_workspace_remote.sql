-- 工作空间的主 remote 选择（契约 §111，Issue #922）。
--
-- 一个工作空间可能有 origin、upstream、fork 等多个 remote；自动识别默认按
-- gh-resolved → upstream → origin → 名字排序挑一个，用户在面板里切换后记在这里。
-- 没有行就是「按默认顺序」。工作空间被移除时行随外键删掉。
--
-- 存的只是 remote 的名字（不是地址）：地址随 `git remote` 改动，名字不在了就当
-- 没选。
CREATE TABLE forge_workspace_remote (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  remote TEXT NOT NULL CHECK(length(remote) BETWEEN 1 AND 255),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
) WITHOUT ROWID;
