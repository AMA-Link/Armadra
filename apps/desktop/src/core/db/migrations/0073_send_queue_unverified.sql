-- 排队项带着「--unverified」（Refs #1026）：没有状态通道的目标（终端 agy）的排队项
-- 出队时要按同一条放行路径再试一次，而不是以 TARGET_STATE_UNVERIFIED 结束。
ALTER TABLE agent_send_queue ADD COLUMN unverified INTEGER NOT NULL DEFAULT 0;
