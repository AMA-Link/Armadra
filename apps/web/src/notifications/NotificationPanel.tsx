/**
 * 铃铛展开的通知面板（§27，契约 §81）。
 *
 * 它不是浮层：铃铛按下时它**顶掉**侧栏「项目」那一段，再按一次（或 Esc）
 * 收回去。里面只有要人处理的事：等待审批、等待回答、出错、交接待批准；
 * 空闲、运行中、完成的都不在。按 工作空间 → 画布 → 节点 三层列出，每层挂着
 * 计数，点一个节点就切过去并定位。处理完（答复、看过、批准）它自己消失。
 *
 * 行是 `Item`：标题 · `StatusPill sm` · 相对时间（等宽）· 缩略 Agent 树 · `⋯`。树只在该
 * 节点有下级或子代理时出现（`useAgentTree` 非空），行高随之到 48。↑↓ 在行之间移动；
 * 树是一个焦点停留点，Tab 进入。
 */
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { NEED_TONE } from "../agent/display";
import { useAgentTree } from "../agent/use-agent-tree";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { displayName } from "../sidebar/display-name";
import {
  AgentInspectDialog,
  type AgentInspectTarget,
} from "../sidebar/AgentInspectDialog";
import { AgentTree } from "@/ui/agent-tree";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Item, ItemActions } from "@/ui/item";
import { useRoving } from "@/ui/roving";
import { ScrollArea } from "@/ui/scroll-area";
import { Skeleton } from "@/ui/skeleton";
import { SkeletonList } from "@/ui/skeletons";
import { Loadable } from "../loading/Loadable";
import { StatusPill } from "@/ui/status-pill";
import type { NeedItem } from "./needs";
import { useNeedsStore } from "./needs-store";

export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const groups = useNeedsStore((state) => state.groups);
  const synced = useNeedsStore((state) => state.synced);
  const open = useNeedsStore((state) => state.open);
  const [inspecting, setInspecting] = useState<AgentInspectTarget | null>(null);
  const roving = useRoving<HTMLDivElement>();

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
        <div
          className="px-2 pb-2"
          ref={roving.ref}
          onFocusCapture={roving.onFocusCapture}
          onKeyDown={(event) => {
            // 焦点在行里的树 / 菜单钮上时，↑↓ 从这一行出发。
            const target = event.target as HTMLElement;
            if (
              (event.key === "ArrowUp" || event.key === "ArrowDown") &&
              !target.closest("[data-roving-item]")
            ) {
              target
                .closest("li")
                ?.querySelector<HTMLElement>("[data-roving-item]")
                ?.focus();
            }
            roving.onKeyDown(event);
          }}
        >
          <Loadable
            loading={!synced && groups.length === 0}
            skeleton={<NotificationSkeleton />}
            empty={groups.length === 0}
            emptyTitle={t("notifications.empty")}
            inline
          >
            {groups.map((workspace) => (
              <section
                key={workspace.workspaceId}
                aria-label={displayName(workspace.name, t)}
              >
                <h2 className="flex h-7 min-w-0 items-center gap-1 px-1.5 text-caption font-medium">
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
                    <h3 className="flex h-6 min-w-0 items-center gap-1 px-1.5 text-caption font-medium text-muted-foreground">
                      <span className="min-w-0 truncate">
                        {displayName(board.name, t)}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {board.count}
                      </span>
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
          </Loadable>
        </div>
      </ScrollArea>
      <AgentInspectDialog
        target={inspecting}
        onClose={() => setInspecting(null)}
      />
    </div>
  );
}

export function NeedRow({
  item,
  label,
  onSelect,
  onInspect,
  now,
}: {
  item: NeedItem;
  label: string;
  onSelect: () => void;
  onInspect: (tab: AgentInspectTarget["tab"]) => void;
  /** 固定「此刻」（毫秒）：相对时间不随真实时间走。展示页用。 */
  now?: number;
}) {
  const t = useT();
  const tree = useAgentTree(item.nodeId, item.title);
  return (
    <li>
      <Item
        size="xs"
        data-need-row=""
        data-tree={tree ? "true" : undefined}
        className="min-h-[36px] flex-nowrap gap-1.5 rounded-control px-1.5 py-0.5 hover:bg-hover"
      >
        <Button
          variant="ghost"
          data-roving-item
          className="h-auto min-w-0 flex-1 justify-start gap-1.5 self-stretch rounded-tight px-0 py-1 text-left font-normal hover:bg-transparent"
          onClick={onSelect}
        >
          <span className="min-w-0 flex-1 truncate text-body">
            {item.title}
          </span>
          <StatusPill
            tone={NEED_TONE[item.need]}
            label={label}
            className="shrink-0"
          />
          <span
            data-numeric
            className="shrink-0 font-mono text-caption text-muted-foreground"
          >
            {formatRelativeTime(item.updatedAt, now)}
          </span>
        </Button>
        <ItemActions className="gap-1">
          {tree ? <AgentTree tree={tree} size="sm" /> : null}
          {item.sessionId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("agentInspect.menu")}>
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-(--z-menu)">
                <DropdownMenuItem onSelect={() => onInspect("transcript")}>
                  {t("agentInspect.transcript")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onInspect("screen")}>
                  {t("agentInspect.screen")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ItemActions>
      </Item>
    </li>
  );
}

/** 两个工作空间分组的占位：组标题（h-7）、画布标题（h-6）、两条节点行（min-h 40px，即 tall）。 */
function NotificationSkeleton() {
  const t = useT();
  return (
    <div
      data-slot="notifications-skeleton"
      role="status"
      aria-busy="true"
      aria-label={t("state.loading")}
    >
      {[0, 1].map((group) => (
        <div key={group}>
          <div className="flex h-7 items-center px-1.5">
            <Skeleton className="h-3 w-1/3" />
          </div>
          <div className="pl-2">
            <div className="flex h-6 items-center px-1.5">
              <Skeleton className="h-3 w-1/4" />
            </div>
            <SkeletonList rows={2} size="tall" secondary />
          </div>
        </div>
      ))}
    </div>
  );
}
