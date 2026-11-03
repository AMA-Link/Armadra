import * as React from "react";
import type { TimelineApprovalItem } from "@armadra/shared";
import Markdown from "react-markdown";

import { useT } from "@/app/preferences-store";
import { ElicitationCard } from "@/acp/ElicitationCard";
import { ExportMenu } from "@/acp/ExportMenu";
import { PermissionCard } from "@/acp/PermissionCard";
import { ApprovalCard, ToolLookupProvider } from "@/acp/TimelineCards";
import { PromptBox } from "@/acp/PromptBox";
import { PlanBar } from "@/timeline/view/PlanBar";
import { TimelineView } from "@/timeline/view/TimelineView";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  ACP_COMMANDS,
  ACP_CONFIG,
  ACP_ELICITATION,
  ACP_ELICITATION_URL,
  ACP_EXPORT_ID,
  ACP_EXPORT_TEXT,
  ACP_FLOW_ITEMS,
  ACP_FLOW_PLAN,
  ACP_ITEMS,
  ACP_MCP_CONFIG,
  ACP_MCP_ITEMS,
  ACP_MCP_MODELS,
  ACP_MCP_MODES,
  ACP_MODELS,
  ACP_MODES,
  ACP_MODES_SHORT,
  ACP_NODE_ID,
  ACP_PERMISSION,
  ACP_PERMISSION_EDIT,
  ACP_PERMISSION_LONG,
  ACP_SESSION_ID,
  ACP_STOP_ITEMS,
  ACP_STREAMING_ACTIVITY,
  ACP_STREAMING_ITEMS,
  ACP_USAGE,
  acpShowcaseBlob,
} from "../fixtures/acp";

/**
 * `acp` 分区（设计展示页 §2.1，设计系统 §5.1–§5.2）：会话视图的真组件喂
 * 假数据。消息流（用户 / 思考 / 三种状态的工具调用 / 差异 / 助手）、流式
 * 尾部、权限卡与错误行、PromptBox 三态（两行输入面：模式、模型 · 思考强度、开关型配置项）、窄屏版、
 * elicitation 表单与链接两种卡片、输出到画板菜单展开；计划卡、图片与资源
 * 链接、模式切换行、四种停止原因、斜杠命令列表与用量（ACP 会话视图 §5）。
 * 一轮活动那一帧：读与搜折成一组、命令与编辑各占一行、待批准的编辑把批准卡挂在
 * 自己的工具行下面，计划条坐在输入框上方。
 * 消息工具条平时悬停才出现，展示页把它们常显出来好截图。
 */

const SOURCE = { nodeId: ACP_NODE_ID, sessionId: ACP_SESSION_ID };

function Frame({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-card border border-border bg-card ${className}`}
    >
      {children}
    </div>
  );
}

const noop = () => undefined;
const sent = async () => true;

const FLOW_BY_ID = Object.fromEntries(
  ACP_FLOW_ITEMS.map((item) => [item.id, item]),
);
const renderFlowApproval = (approval: TimelineApprovalItem) => (
  <ApprovalCard approval={approval} canAnswer />
);

const MCP_BY_ID = Object.fromEntries(
  ACP_MCP_ITEMS.map((item) => [item.id, item]),
);

const SERVICES = { loadBlob: acpShowcaseBlob, source: SOURCE };

/** 展示页：消息工具条常显。 */
const SHOW_ACTIONS = "[&_[data-slot=acp-actions]]:opacity-100";

export default function AcpSection() {
  const t = useT();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <Frame>
          <div className={`flex h-[760px] flex-col ${SHOW_ACTIONS}`}>
            <TimelineView items={ACP_ITEMS} services={SERVICES} />
          </div>
        </Frame>
        <Frame>
          <ToolLookupProvider value={FLOW_BY_ID}>
            <div className="flex h-[420px] flex-col">
              <TimelineView
                items={ACP_FLOW_ITEMS}
                renderApproval={renderFlowApproval}
              />
            </div>
          </ToolLookupProvider>
          <PlanBar plan={ACP_FLOW_PLAN} className="mb-1" />
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming
            modes={ACP_MODES}
            models={ACP_MODELS}
            configOptions={ACP_CONFIG}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
            onModel={noop}
            onConfig={noop}
          />
        </Frame>
        <Frame className="max-w-[520px]">
          <div data-showcase="acp-mcp" className="flex flex-col">
            <ToolLookupProvider value={MCP_BY_ID}>
              <div className="flex h-[400px] flex-col">
                <TimelineView
                  items={ACP_MCP_ITEMS}
                  renderApproval={renderFlowApproval}
                />
              </div>
            </ToolLookupProvider>
            <PromptBox
              sessionId={null}
              disabled={false}
              streaming
              modes={ACP_MCP_MODES}
              models={ACP_MCP_MODELS}
              configOptions={ACP_MCP_CONFIG}
              usage={{ used: 41_000, size: 258_000 }}
              onSubmit={sent}
              onCancel={noop}
              onMode={noop}
              onModel={noop}
              onConfig={noop}
            />
          </div>
        </Frame>
        <Frame>
          <div className="flex h-[260px] flex-col">
            <TimelineView items={ACP_STOP_ITEMS} onContinue={noop} />
          </div>
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming={false}
            modes={ACP_MODES_SHORT}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
            commands={ACP_COMMANDS}
            usage={ACP_USAGE}
            prefill={{ text: "/", seq: 1 }}
          />
        </Frame>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Frame className="flex-row items-start gap-2 p-2.5 pb-44">
          <div className="timeline-prose min-w-0 flex-1 text-body leading-relaxed">
            <Markdown>{ACP_EXPORT_TEXT.split("\n\n")[0] ?? ""}</Markdown>
          </div>
          <ExportMenu
            text={ACP_EXPORT_TEXT}
            source={{ ...SOURCE, messageId: ACP_EXPORT_ID }}
            defaultOpen
          />
        </Frame>
        <Frame>
          <div className="flex h-[240px] flex-col">
            <TimelineView
              items={ACP_STREAMING_ITEMS}
              activity={ACP_STREAMING_ACTIVITY}
            />
          </div>
          <PermissionCard
            permission={ACP_PERMISSION}
            canAnswer
            className="mx-2 mb-1.5"
          />
          <PermissionCard
            permission={ACP_PERMISSION_EDIT}
            canAnswer
            className="mx-2 mb-1.5"
          />
          <PermissionCard
            permission={ACP_PERMISSION_LONG}
            canAnswer
            className="mx-2 mb-1.5"
          />
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming
            usage={{ used: 12_300, size: 200_000 }}
            modes={ACP_MODES}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
          />
        </Frame>

        <Frame>
          <div className="flex flex-col gap-2 p-2.5">
            <Alert variant="destructive">
              <AlertTitle>{t("acp.error.turn")}</AlertTitle>
              <AlertAction>
                <Button size="xs" variant="outline">
                  {t("acp.error.retry")}
                </Button>
              </AlertAction>
            </Alert>
          </div>
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming={false}
            modes={ACP_MODES}
            models={ACP_MODELS}
            configOptions={ACP_CONFIG}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
            onModel={noop}
            onConfig={noop}
          />
        </Frame>

        <Frame>
          <div className="flex flex-col gap-2 p-2.5">
            <ElicitationCard view={ACP_ELICITATION_URL} canAnswer />
          </div>
          <ElicitationCard
            view={ACP_ELICITATION}
            canAnswer
            className="mx-2 mb-1.5"
          />
          <PromptBox
            sessionId={null}
            disabled={false}
            streaming={false}
            modes={ACP_MODES}
            models={ACP_MODELS}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
            onModel={noop}
            configOptions={ACP_CONFIG}
            onConfig={noop}
            compact
          />
        </Frame>

        <Frame>
          <Alert className="rounded-none border-x-0 border-t-0 py-1.5">
            <AlertTitle className="text-meta">{t("acp.offline")}</AlertTitle>
          </Alert>
          <PromptBox
            sessionId={null}
            disabled
            streaming={false}
            modes={null}
            onSubmit={sent}
            onCancel={noop}
            onMode={noop}
          />
        </Frame>
      </div>
    </div>
  );
}
