-- 重启恢复（契约 §101.5，#704）。
-- recovery_pending  启动扫描发现这一项中断（成员没有活着的会话）时置 1，成员续接后
--                   第一次报告空闲时 core 投一条固定的恢复提示并清零，所以每次中断只
--                   投一次。
ALTER TABLE workflow_task_runs ADD COLUMN recovery_pending INTEGER NOT NULL DEFAULT 0;
