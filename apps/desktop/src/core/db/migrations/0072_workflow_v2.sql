-- 工作流 v2（Refs #996）。只加列。
--
-- round / verdict_json：步骤的轮次与最近一次验证结论（collect 步骤被退回重做时 +1）。
ALTER TABLE workflow_run_steps ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_run_steps ADD COLUMN verdict_json TEXT;
-- 模板来自哪份项目级 `.ama/workflows/<id>.md`：`<workspaceId>/<id>`；人建的为空。
ALTER TABLE workflow_templates ADD COLUMN file_ref TEXT;
CREATE UNIQUE INDEX workflow_templates_file_ref ON workflow_templates(file_ref) WHERE file_ref IS NOT NULL;
-- 托管运行的发起节点（`workflow-run`）；页面起的为空。
ALTER TABLE workflow_runs ADD COLUMN started_by_node_id TEXT;
