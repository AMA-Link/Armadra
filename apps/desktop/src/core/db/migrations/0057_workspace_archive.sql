-- 工作空间归档（契约 §89，#678）：`NULL` 是没归档；归档时刻是 RFC 3339。
-- 归档只是从列表里收起来，行与它级联的画布、会话记录都原样留着，恢复就是清空这一列。
ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
