-- 会话时间线（契约 §82，设计 acp-progressive-view §2）：一条会话行一条时间线，条目存最新的完整值，
-- 任何游标的增量同步都是一次 `rev > after` 的范围查询，不需要保留操作日志。
--
--   timelines.id          = terminal_sessions.id（驱动切换不换行 id，切换前后共用一条）。
--   timelines.head_seq    已写到的序号，单调递增；条目的 rev 等于最后一次修改它的序号。
--   timelines.head_rev    头部值（用量、命令、模式、模型目录、标题）最后一次修改的序号。
--   timelines.source_cursor  外部来源的续读游标（转录尾读的字节偏移等），由来源自己解释。
--   timeline_items.deleted   1 = 墓碑，data_json 为空，只让增量同步把删除传出去。
--   timeline_blobs        条目引用的图片 / 音频 / 资源（字节在数据目录 timeline/blobs/<sha256>）。
--
-- 不对 nodes 建外键：ACP 会话先于节点落盘就会开始写时间线。节点没了之后由启动清理回收。
CREATE TABLE timelines (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 128),
  node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128),
  head_seq INTEGER NOT NULL DEFAULT 0 CHECK(head_seq >= 0),
  head_rev INTEGER NOT NULL DEFAULT 0 CHECK(head_rev >= 0),
  source TEXT NOT NULL DEFAULT 'acp' CHECK(length(source) <= 40),
  source_cursor TEXT NOT NULL DEFAULT '' CHECK(length(source_cursor) <= 2048),
  head_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE INDEX timelines_by_node ON timelines(node_id);
CREATE INDEX timelines_by_workspace ON timelines(workspace_id);

CREATE TABLE timeline_items (
  timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL CHECK(length(item_id) BETWEEN 1 AND 300),
  turn INTEGER NOT NULL DEFAULT 0 CHECK(turn >= 0),
  ord INTEGER NOT NULL DEFAULT 0 CHECK(ord >= 0),
  kind TEXT NOT NULL DEFAULT '' CHECK(length(kind) <= 40),
  rev INTEGER NOT NULL CHECK(rev > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
  data_json TEXT,
  PRIMARY KEY (timeline_id, item_id)
);

CREATE INDEX timeline_items_by_rev ON timeline_items(timeline_id, rev);
CREATE INDEX timeline_items_by_turn ON timeline_items(timeline_id, turn, ord);

CREATE TABLE timeline_blobs (
  timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL CHECK(length(blob_id) BETWEEN 1 AND 128),
  mime_type TEXT NOT NULL DEFAULT '' CHECK(length(mime_type) <= 200),
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  PRIMARY KEY (timeline_id, blob_id)
) WITHOUT ROWID;

CREATE INDEX timeline_blobs_by_blob ON timeline_blobs(blob_id);
