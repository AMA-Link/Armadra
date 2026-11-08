-- 交接 v2：目标可以是「新开的 Agent」（契约 §39.8，Issue #872）。
--
-- 冻结的行（`freeze_agent_handoff_bundle` 触发器）不允许改 target_node_id、
-- target_session_id、target_generation 与 bundle_json——它们是预览时看到、批准时
-- 比对的那一份。新开目标在预览时还没有节点，也没有会话：包里记目标规格，这三列
-- 记空串 / 0；批准时才建出节点。
--
-- created_target_node_id  accept 建出来的那个节点。只写一次（NULL → 节点 id），
--                         不在冻结触发器的列表里。已有节点的交接恒为 NULL。
--                         新开目标的读取与确认以它为准：调用方节点必须就是它，
--                         会话与代次在读取时按该节点当前会话判定。
ALTER TABLE agent_handoffs ADD COLUMN created_target_node_id TEXT;
CREATE INDEX idx_agent_handoffs_created_target
  ON agent_handoffs(created_target_node_id, state);
