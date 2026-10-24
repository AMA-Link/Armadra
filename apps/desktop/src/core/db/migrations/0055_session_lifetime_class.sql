-- 会话寿命类别（契约 §31.3，#484）：
--   standard  30 天的常规会话（口令、配对、个人中转）。
--   bounded   限寿会话（经 Armadra 云断言准入，约一小时）：刷新续不过寿命，只有带新断言的 cloud/login 能续。
-- 显式记在会话行上，不靠到期减创建时刻推断。
ALTER TABLE identity_sessions ADD COLUMN lifetime_class TEXT NOT NULL DEFAULT 'standard' CHECK(lifetime_class IN ('standard', 'bounded'));
