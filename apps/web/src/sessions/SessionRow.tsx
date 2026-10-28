/**
 * 会话行（§3.5）。
 *
 * 左侧 `StatusDot 8`（需要你 / 运行中呼吸，未读、完成、空闲各自一色）→ 标题（双击
 * 改名）→ Agent 标签 → `×` 结束；第二行等宽：目录名与「处于该状态多久」。点击行选中并
 * 把画布居中到该节点。行是 roving 列表的一项（↑↓ 在会话间移动）。
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { agentLabel, agentTextColorVar } from "../agent/launch";
import { basename, type SessionRow as SessionRowData } from "../agent/sessions";
import { displayOfRow } from "../agent/display";
import { useAgentStatusStore } from "../agent/status-store";
import { runtimeApi } from "../api/client";
import { sessionGateway } from "../session";
import {
  CENTER_NODE_EVENT,
  requestCenterOnNode,
} from "../canvas/flow/flow-context";
import { formatDuration } from "../lib/format";
import { useT } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { StatusDot } from "../ui/status-pill";
import { toast } from "../ui/toast";

/**
 * 居中事件的定义搬到了 `canvas/flow/flow-context.ts`，这里只转出去，
 * 免得侧栏与画布各存一份事件名。画布还没挂载时事件没人接，也不会报错。
 */
export { CENTER_NODE_EVENT };
export const centerNode = requestCenterOnNode;

export function SessionRow({ row }: { row: SessionRowData }) {
  const t = useT();
  // 状态点、图标与色调都从同一个显示结果来（出错不再画成绿色，S1）。
  const display = displayOfRow(row);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const updateNode = useCanvasStore((state) => state.updateNode);
  const markRead = useAgentStatusStore((state) => state.markRead);
  const selected = useCanvasStore((state) =>
    state.selectedNodeIds.includes(row.nodeId),
  );

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  // 名字与颜色都走 `agent/launch`：自定义 Agent 不在内置注册表里，
  // 得靠 `GET /api/agents` 那份快照才认得（§24.1）。
  const agentId = row.agentId;
  // 会话行带上 core 报的驱动方式；旧 core 不报时退回节点数据里写明的那个。
  const nodeDriver = useCanvasStore((state) => {
    const node = state.document?.nodes.find((item) => item.id === row.nodeId);
    return node?.data.kind === "terminal" ? node.data.agent?.driver : undefined;
  });
  const acp = row.backend ? row.backend === "acp" : nodeDriver === "acp";

  const activate = () => {
    markRead(row.nodeId);
    selectNodes([row.nodeId]);
    centerNode(row.nodeId);
  };

  const commitRename = () => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === row.title) {
      setDraft(row.title);
      return;
    }
    updateNode(row.nodeId, { title });
  };

  const terminate = () => {
    setConfirming(false);
    void sessionGateway
      .terminate(
        useCanvasStore.getState().workspace?.id ?? "",
        row.sessionId,
        "session",
      )
      .catch(() => toast.error(t("sessions.terminateFailed")));
  };

  return (
    <div
      className="group flex items-start gap-0.5 rounded-control pr-1"
      data-selected={selected ? "true" : undefined}
      onAuxClick={(event) => {
        // 中键 = `×`：先问一句再结束。
        if (event.button !== 1) return;
        event.preventDefault();
        setConfirming(true);
      }}
    >
      {renaming ? (
        <Input
          ref={input}
          value={draft}
          autoFocus
          size="sm"
          className="flex-1"
          aria-label={t("sessions.rename")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") {
              setDraft(row.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <Button
          variant="ghost"
          className="h-auto min-h-14 flex-1 flex-col items-stretch justify-center gap-0 rounded-control px-2 py-1 font-normal hover:bg-hover data-[selected=true]:bg-brand-soft data-[selected=true]:text-foreground"
          data-roving-item
          data-selected={selected ? "true" : undefined}
          title={row.cwd}
          onClick={activate}
          onDoubleClick={() => {
            setDraft(row.title);
            setRenaming(true);
          }}
        >
          <span className="flex w-full items-center gap-1.5">
            <StatusDot
              tone={display.tone}
              size={8}
              label={t(display.labelKey)}
            />
            <span className="flex-1 truncate text-left text-body">
              {row.title}
            </span>
            {acp && (
              <Badge
                variant="outline"
                data-slot="session-row-acp"
                size="sm"
                className="shrink-0 font-normal"
              >
                {t("acp.backend")}
              </Badge>
            )}
            {agentId && (
              <span
                data-slot="session-row-agent"
                className="shrink-0 text-caption"
                style={{ color: agentTextColorVar(agentId) }}
              >
                {agentLabel(agentId)}
              </span>
            )}
          </span>
          <span className="flex w-full items-center gap-1.5 font-mono text-caption font-normal text-muted-foreground">
            <span className="truncate">{basename(row.cwd)}</span>
            <span data-numeric className="ml-auto shrink-0">
              {formatDuration(row.sinceMs)}
            </span>
          </span>
        </Button>
      )}

      <IconButton
        label={t("sessions.terminate")}
        className="mt-1.5 opacity-0 transition-opacity duration-(--dur-base) group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => setConfirming(true)}
      >
        <X />
      </IconButton>

      <ResponsiveAlertDialog open={confirming} onOpenChange={setConfirming}>
        <ResponsiveAlertDialogContent aria-describedby={undefined}>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("sessions.terminateTitle", { title: row.title })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("sessions.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={terminate}
            >
              {t("sessions.terminateConfirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  );
}
