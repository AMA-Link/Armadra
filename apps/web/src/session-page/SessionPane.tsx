import * as React from "react";
import { ArrowLeft, Crosshair } from "lucide-react";

import { SessionSkeleton } from "@/acp/SessionSkeleton";
import { driverOf } from "@/acp/driver";
import { agentLabel, agentMark } from "@/agent/launch";
import { runtimeApi } from "@/api/client";
import { HeaderApproval } from "@/approval/ApprovalShell";
import { useT } from "@/app/preferences-store";
import { gotoNode } from "@/sidebar/goto-node";
import { useCanvasStore } from "@/store/canvas-store";
import { ContextReadsBadge } from "@/nodes/ContextReadsBadge";
import { DeliveryQueueBadge } from "@/nodes/DeliveryQueueBadge";
import { DriveBadge } from "@/nodes/DriveBadge";
import { cn } from "@/lib/cn";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { StatusPill } from "@/ui/status-pill";
import { Textarea } from "@/ui/textarea";
import { toast } from "@/ui/toast";
import type { AgentSessionItem } from "./model";
import { useSessionPage } from "./store";
import { useSessionHeader } from "./use-session-header";

/** 消息流带着 Markdown 渲染：和画布上的节点体一样按需加载。 */
const SessionView = React.lazy(() => import("@/acp/SessionView"));

export function SessionPane({
  item,
  onBack,
  clearOfCluster,
}: {
  item: AgentSessionItem;
  /** 手机布局：回到列表。 */
  onBack?: (() => void) | undefined;
  /** 桌面：右上工具簇压在头部右端，让开它。 */
  clearOfCluster: boolean;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? "");
  const agent = item.data.agent;
  const acp = driverOf(agent) === "acp";
  const sessionId = item.data.sessionId ?? item.session?.sessionId ?? null;
  const header = useSessionHeader(
    item.nodeId,
    agent,
    sessionId,
    workspaceId,
    item.session,
  );

  const locate = () => {
    useSessionPage.getState().close();
    gotoNode(item.boardId, item.nodeId);
  };

  return (
    <section
      data-slot="session-pane"
      data-node-id={item.nodeId}
      aria-label={item.title}
      className="flex h-full min-w-0 flex-col"
    >
      <header
        className={cn(
          "flex h-12 shrink-0 items-center gap-2 border-b pl-3",
          clearOfCluster ? "pr-16" : "pr-3",
        )}
      >
        {onBack && (
          <IconButton label={t("sessionPage.back")} onClick={onBack}>
            <ArrowLeft />
          </IconButton>
        )}
        <AgentAvatar
          agentId={agent?.id ?? ""}
          size={20}
          text={agentMark(agent?.id)}
        />
        <h2
          className="min-w-0 truncate font-medium"
          title={agentLabel(agent?.id)}
        >
          {item.title}
        </h2>
        <StatusPill
          tone={header.pill.tone}
          label={t(header.pill.labelKey)}
          data-slot="session-status"
        />
        {header.approval && (
          <HeaderApproval onAnswer={header.approval.onAnswer} />
        )}
        <DriveBadge nodeId={item.nodeId} sessionId={sessionId} />
        <DeliveryQueueBadge nodeId={item.nodeId} workspaceId={workspaceId} />
        <ContextReadsBadge nodeId={item.nodeId} visible />
        <div className="flex-1" />
        {!item.onSessionBoard && (
          <IconButton label={t("sessionPage.locate")} onClick={locate}>
            <Crosshair />
          </IconButton>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        <React.Suspense fallback={<SessionSkeleton />}>
          {acp ? (
            <SessionView
              key={item.nodeId}
              nodeId={item.nodeId}
              data={item.data}
            />
          ) : sessionId === null ? (
            <SessionSkeleton />
          ) : (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <SessionView
                  key={`${item.nodeId}:${sessionId}`}
                  nodeId={item.nodeId}
                  data={item.data}
                  readOnly
                  sessionId={sessionId}
                />
              </div>
              <TerminalInput sessionId={sessionId} />
            </div>
          )}
        </React.Suspense>
      </div>
    </section>
  );
}

/** 终端驱动的会话没有输入框：这一行把话括号粘贴进那条 PTY 并回车。 */
function TerminalInput({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);

  const send = async () => {
    const value = text.trim();
    if (value === "" || sending) return;
    setSending(true);
    try {
      await runtimeApi.pasteTerminal(sessionId, value, true);
      setText("");
    } catch {
      toast.error(t("sessionPage.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      data-slot="session-terminal-input"
      className="flex shrink-0 items-end gap-2 border-t p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        size="sm"
        rows={1}
        className="min-h-0 max-h-40 flex-1 resize-none"
        value={text}
        aria-label={t("sessionPage.input")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Button
        type="submit"
        size="sm"
        disabled={text.trim() === ""}
        loading={sending}
      >
        {t("sessionPage.send")}
      </Button>
    </form>
  );
}
