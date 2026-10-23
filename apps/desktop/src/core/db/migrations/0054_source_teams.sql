-- 分享来的源属于哪个团队（契约 §86，云端控制台 U7c）：
--   team_id    分享方在 cloud/login 的 share 里报的团队标识；空串 = 个人分享、本机、配对或旧对端。
--   team_name  同一份里报的团队名字；不知道是空串。
-- 都是展示用的分组提示：权限由分享方的 core 判定，这里不参与任何授权。
ALTER TABLE client_sources ADD COLUMN team_id TEXT NOT NULL DEFAULT '' CHECK(length(team_id) <= 128);
ALTER TABLE client_sources ADD COLUMN team_name TEXT NOT NULL DEFAULT '' CHECK(length(team_name) <= 128);
