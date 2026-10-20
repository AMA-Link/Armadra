/**
 * 铃铛展开的通知面板（§27，契约 §81）。
 *
 * 它不是浮层：铃铛按下时它**顶掉**侧栏「项目」那一段，再按一次（或 Esc）
 * 收回去。里面只有要人处理的事：等待审批、等待回答、出错、交接待批准；
 * 空闲、运行中、完成的都不在。按 工作空间 → 画布 → 节点 三层列出，每层挂着
 * 计数，点一个节点就切过去并定位。处理完（答复、看过、批准）它自己消失。
 */
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { NEED_TONE } from "../agent/display";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { displayName } from "../sidebar/display-name";
import {
  AgentInspectDialog,
  type AgentInspectTarget,
} from "../sidebar/AgentInspectDialog";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { StatusPill } from "@/ui/status-pill";
import type { NeedItem } from "./needs";
import { useNeedsStore } from "./needs-store";

export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const groups = useNeedsStore((state) => state.groups);
  const open = useNeedsStore((state) => state.open);
  const [inspecting, setInspecting] = useState<AgentInspectTarget | null>(null);

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
          {groups.length === 0 && (
            <p className="px-1.5 py-2 text-[length:var(--text-caption)] text-muted-foreground">
              {t("notifications.empty")}
            </p>
          )}
          {groups.map((workspace) => (
            <section
              key={workspace.workspaceId}
              aria-label={displayName(workspace.name, t)}
            >
              <h2 className="flex h-7 min-w-0 items-center gap-1 px-1.5 text-[length:var(--text-caption)] font-medium">
                <span className="min-w-0 truncate">
                  {displayName(workspace.name, t)}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {workspace.count}
                </span>
              </h2>
              {workspace.boards.map((board) => (
                <section
                  key={board.boardId}
                  aria-label={displayName(board.name, t)}
                  className="pl-2"
                >
                  <h3 className="flex h-6 min-w-0 items-center gap-1 px-1.5 text-[length:var(--text-caption)] font-medium text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {displayName(board.name, t)}
                    </span>
                    <span className="shrink-0 tabular-nums">{board.count}</span>
                  </h3>
                  <ul>
                    {board.items.map((item) => (
                      <NeedRow
                        key={item.key}
                        item={item}
                        label={t(`notifications.need.${item.need}`)}
                        onSelect={() => {
                          onClose();
                          open(item);
                        }}
                        onInspect={(tab) =>
                          setInspecting({
                            workspaceId: item.workspaceId,
                            nodeId: item.nodeId,
                            sessionId: item.sessionId ?? "",
                            title: item.title,
                            tab,
                          })
                        }
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
      <AgentInspectDialog
        target={inspecting}
        onClose={() => setInspecting(null)}
      />
    </div>
  );
}

function NeedRow({
  item,
  label,
  onSelect,
  onInspect,
}: {
  item: NeedItem;
  label: string;
  onSelect: () => void;
  onInspect: (tab: AgentInspectTarget["tab"]) => void;
}) {
  const t = useT();
  return (
    <li className="group/need relative">
      <Button
        variant="ghost"
        size="sm"
        className="motion-hover h-auto min-h-[40px] w-full min-w-0 flex-col items-stretch gap-px rounded-[var(--r-control)] px-1.5 py-1 font-normal hover:bg-[var(--hover)]"
        onClick={onSelect}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-left text-[length:var(--text-body)]">
            {item.title}
          </span>
          <StatusPill
            tone={NEED_TONE[item.need]}
            label={label}
            className="shrink-0"
          />
        </span>
        <span className="w-full text-left text-[length:var(--text-caption)] tabular-nums text-muted-foreground">
          {formatRelativeTime(item.updatedAt)}
        </span>
      </Button>
      {item.sessionId && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              label={t("agentInspect.menu")}
              className="absolute top-1 right-1.5 opacity-0 focus-visible:opacity-100 group-hover/need:opacity-100 data-[state=open]:opacity-100"
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
      )}
    </li>
  );
}
