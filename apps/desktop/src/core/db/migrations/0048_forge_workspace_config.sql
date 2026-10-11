-- 托管平台配置按工作空间（契约 §75，issue #329）。
--
-- `forge_config`（0038）是整台机器一份；这张表放某个工作空间自己的那份，列与
-- 含义相同，键多一个 `workspace_id`。识别时先看工作空间的仓库行、再看工作空间的
-- 主机行，都没有才回到整机的两种行。
--
-- **令牌不在这里**：`credential_ref` 仍是 SecretStore 里的条目名。工作空间被移除
-- 时行随外键删掉；它指着的密钥条目不再被任何行引用。
CREATE TABLE forge_workspace_config (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_key TEXT NOT NULL CHECK(length(repo_key) BETWEEN 1 AND 512),
  forge TEXT NOT NULL CHECK(forge IN ('github', 'gitea', 'gitlab')),
  api_base TEXT NOT NULL CHECK(length(api_base) BETWEEN 1 AND 2048),
  credential_ref TEXT NOT NULL DEFAULT '' CHECK(length(credential_ref) <= 256),
  account_login TEXT NOT NULL DEFAULT '' CHECK(length(account_login) <= 256),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0),
  PRIMARY KEY (workspace_id, repo_key)
) WITHOUT ROWID;
