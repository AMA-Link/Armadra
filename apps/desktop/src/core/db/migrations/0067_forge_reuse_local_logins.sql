-- 代码托管「复用本机登录」开关（契约 §111.6，Issue #922）。
--
-- 单例。没有行 = 按壳的默认：桌面壳开、服务器壳关（环境变量
-- `ARMADRA_FORGE_REUSE_LOGINS=1` 才开）。用户在设置里切一次就写下这一行，之后以它为准。
--
-- 令牌不在这里：复用的令牌每次现读（gh / glab / tea / git credential），只在内存里
-- 短暂缓存，关开关即清。
CREATE TABLE forge_reuse_local_logins (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);
