-- 板的种类（Armadra#1062 S2）：`canvas` 是画布；`sessions` 是一个工作空间的会话板，
-- 页面里新建、不在任何画布上的 Agent 会话就是这块板上的节点。会话板不出现在
-- 画板列表里，每个工作空间至多一块，由 core 在第一次需要时建。
ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'canvas'
  CHECK (kind IN ('canvas', 'sessions'));

CREATE UNIQUE INDEX boards_one_sessions_board ON boards(workspace_id)
  WHERE kind = 'sessions';
