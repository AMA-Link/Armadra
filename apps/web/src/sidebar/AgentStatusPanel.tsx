/**
 * 铃铛展开的 Agent 状态面板（§27）。
 *
 * 它不是浮层：铃铛按下时它**顶掉**侧栏「项目」那一段，再按一次（或 Esc）
 * 收回去。这样一来「我的 Agent 现在都怎么样了」和「我要去哪块板」共用同一
 * 块地方，侧栏不会越长越高。
 *
 * 数据是现成的：`GET /sessions` 给会话，`agent/status-store` 给实时状态，
 * `agent/sessions` 已经把两者合流并分好桶。按 Agent 所在的画布分区（当前
 * 画布在前），区内按状态先后排；一行 = 标题 + 状态胶囊 + 目录 + 相对时间，
 * 点一行就切到那块板并把画布居中过去。哪些行算 Agent 见 `agent-panel.ts`。
 */
import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { basename, useSessions, type SessionRow } from "../agent/sessions";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { agentSections, bucketTone } from "./agent-panel";
import {
  AgentInspectDialog,
  type AgentInspectTarget,
} from "./AgentInspectDialog";
import { gotoNode } from "./goto-node";
import { displayName } from "./display-name";

export function AgentStatusPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const currentBoardId = useCanvasStore((state) => state.boardId);
  const { sessions, isPending } = useSessions(workspace?.id ?? null);
  const [inspecting, setInspecting] = useState<AgentInspectTarget | null>(null);

  const sections = useMemo(
    () =>
      agentSections(sessions, {
        currentBoardId,
        boardOrder: boards.map((board) => board.id),
      }),
    [boards, currentBoardId, sessions],
  );
  const boardNames = useMemo(
    () =>
      new Map(boards.map((board) => [board.id, displayName(board.name, t)])),
    [boards, t],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2">
          {!isPending && sections.length === 0 && (
            <p className="px-1.5 py-2 text-[length:var(--text-caption)] text-muted-foreground">
              {t("sidebar.agentsEmpty")}
            </p>
          )}
          {sections.map((section) => {
            const name =
              boardNames.get(section.boardId) ?? t("sidebar.agentsOtherBoard");
            return (
              <section key={section.boardId} aria-label={name}>
                <h2 className="flex h-7 min-w-0 items-center gap-1 px-1.5 text-[length:var(--text-caption)] font-medium text-muted-foreground">
                  <span className="min-w-0 truncate">{name}</span>
                  <span className="shrink-0 tabular-nums">
                    {section.entries.length}
                  </span>
                </h2>
                <ul>
                  {section.entries.map(({ row, bucket }) => (
                    <AgentRow
                      key={row.nodeId}
                      row={row}
                      tone={bucketTone(bucket)}
                      label={t(`sessions.bucket.${bucket}`)}
                      onSelect={() => {
                        onClose();
                        gotoNode(row.boardId, row.nodeId);
                      }}
                      onInspect={(tab) =>
                        setInspecting({
                          workspaceId: workspace?.id ?? "",
                          nodeId: row.nodeId,
                          sessionId: row.sessionId,
                          title: row.title,
                          tab,
                        })
                      }
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </ScrollArea>
      <AgentInspectDialog
        target={inspecting}
        onClose={() => setInspecting(null)}
      />
    </div>
  );
}

function AgentRow({
  row,
  tone,
  label,
  onSelect,
  onInspect,
}: {
  row: SessionRow;
  tone: StatusTone;
  label: string;
  onSelect: () => void;
  onInspect: (tab: AgentInspectTarget["tab"]) => void;
}) {
  const t = useT();
  return (
    <li className="group/agent relative">
      <Button
        variant="ghost"
        size="sm"
        title={row.cwd}
        className="motion-hover h-auto min-h-[40px] w-full min-w-0 flex-col items-stretch gap-px rounded-[var(--r-control)] px-1.5 py-1 font-normal hover:bg-[var(--hover)]"
        onClick={onSelect}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-left text-[length:var(--text-body)]">
            {row.title}
          </span>
          <StatusPill tone={tone} label={label} className="shrink-0" />
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[length:var(--text-caption)] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate text-left">
            {basename(row.cwd)}
          </span>
          <span className="shrink-0 tabular-nums">
            {formatRelativeTime(row.updatedAt)}
          </span>
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={t("agentInspect.menu")}
            className="absolute top-1 right-1.5 opacity-0 focus-visible:opacity-100 group-hover/agent:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[var(--z-menu)]">
          <DropdownMenuItem onSelect={() => onInspect("transcript")}>
            {t("agentInspect.transcript")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onInspect("screen")}>
            {t("agentInspect.screen")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
