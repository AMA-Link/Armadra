-- Agent 回合被合成收尾的原因（Refs #988，契约 §114 之后的交付状态节）。
--
-- 'stale'（长时间没有 hook 回报）、'terminated'（回合中终端退出）、'modelError'
-- （模型报错后 CLI 没有收尾）；NULL = 正常结束或回合进行中。H2 之后这个原因只写在
-- lastMessage 里，lastMessage 不是列，重启就丢了，所以落库。
ALTER TABLE agent_status ADD COLUMN ended_by TEXT;
