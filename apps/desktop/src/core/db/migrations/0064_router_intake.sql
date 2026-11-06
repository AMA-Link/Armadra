-- 协调者的来源与主动接单（契约 §104，#830，R4 第二阶段）。
--
-- router_sources    一个协调者节点盯着的一个仓库。只有人能配（分派抽屉），
--                   没有任何 canvas 动词能建、改、删它。
-- repo              `<主机>/<owner>/<名字>`，与 §103.1 同写法。
-- kinds             JSON 数组：["issue"] / ["pull"] / 两者。
-- mode              observe（只记判定）/ auto（判定为接且授权时可以起工作项）。
-- allow_json        允许名单（远端登录名，小写，至多 50 个）。
-- rules_hash        人确认过的规则文件哈希（sha256 前 16 位）；空串是没确认过。
-- cursor_at         列表游标（毫秒）：看过的线程里最晚的 updatedAt；建来源时记现在，
--                   不回灌之前的线程。
--
-- router_intake     候选：一个没人认领的线程的一次「要不要接」。id 确定，
--                   `intake:<仓库>#<编号>:<issue|pull>:<版本>`，重放不出第二条。
--                   不存正文：标题、作者、链接之外的东西在协调者要看时现读。
-- request_json      `{ by, via: "thread" | "comment", commentId?, at }`。
-- authorized        request.by 在允许名单里（提起时核对，接单时再核一次）。
-- verdict           空 / accept / skip；判定一次定死。
-- review            人的复核：空 / agree / disagree。
-- item_id           接单后的工作项；不设外键，工作项行删了账还在。
-- outcome           空 / dispatched / refused:<原因码>。
CREATE TABLE router_sources (
  id TEXT PRIMARY KEY,
  coordinator_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo TEXT NOT NULL CHECK(length(repo) BETWEEN 1 AND 300),
  kinds TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'observe' CHECK(mode IN ('observe', 'auto')),
  allow_json TEXT NOT NULL DEFAULT '[]',
  rules_hash TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  cursor_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (coordinator_node_id, repo)
);

CREATE TABLE router_intake (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 400),
  source_id TEXT NOT NULL REFERENCES router_sources(id) ON DELETE CASCADE,
  coordinator_node_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issue', 'pull')),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  url TEXT NOT NULL,
  request_json TEXT NOT NULL,
  authorized INTEGER NOT NULL DEFAULT 0,
  source_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  verdict TEXT CHECK(verdict IS NULL OR verdict IN ('accept', 'skip')),
  verdict_reason TEXT,
  verdict_at INTEGER,
  rules_hash TEXT,
  mode_at_verdict TEXT,
  review TEXT CHECK(review IS NULL OR review IN ('agree', 'disagree')),
  reviewed_at INTEGER,
  item_id TEXT,
  dispatched_at INTEGER,
  outcome TEXT
);
CREATE INDEX router_intake_verdict ON router_intake(coordinator_node_id, verdict);
CREATE INDEX router_intake_thread ON router_intake(source_id, repo, number, kind);
