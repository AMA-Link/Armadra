import * as React from "react";
import { MessagesSquare, X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { useCompactLayout } from "@/platform/layout";
import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui/icon-button";
import { EmptyState } from "@/ui/state";
import { flatten } from "./model";
import { NewSessionDialog } from "./NewSessionDialog";
import { SessionList } from "./SessionList";
import { SessionPane } from "./SessionPane";
import { useSessionPage } from "./store";
import { useWorkspaceAgentSessions } from "./use-agent-sessions";

/**
 * 会话页：工作空间里全部 Agent 会话（画布上的与会话板上的）。左边按状态分组的
 * 上下级树，右边是选中的那一条；窄屏只留一栏，列表与详情来回切。
 */
export default function SessionPage() {
  const t = useT();
  const compact = useCompactLayout();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const { tree, items, loading, refresh } =
    useWorkspaceAgentSessions(workspaceId);
  const selectedNodeId = useSessionPage((state) => state.selectedNodeId);
  const select = useSessionPage((state) => state.select);
  const close = useSessionPage((state) => state.close);
  const [creating, setCreating] = React.useState(false);

  const selected = items.find((item) => item.nodeId === selectedNodeId);
  const ordered = React.useMemo(() => flatten(tree), [tree]);
  const showList = !compact || selected === undefined;
  const showPane = !compact || selected !== undefined;

  return (
    <section
      data-slot="session-page"
      aria-label={t("sessionPage.title")}
      className="absolute inset-0 z-[var(--z-session-page)] flex bg-background"
    >
      {showList && (
        <aside
          className={cn(
            "flex min-h-0 flex-col",
            compact ? "w-full" : "w-(--sidebar-w) shrink-0 border-r",
          )}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-3">
            <h1 className="min-w-0 flex-1 truncate font-medium">
              {t("sessionPage.title")}
            </h1>
            <IconButton label={t("sessionPage.close")} onClick={close}>
              <X />
            </IconButton>
          </header>
          <SessionList
            tree={tree}
            count={ordered.length}
            selectedNodeId={selectedNodeId}
            onSelect={select}
            onNew={() => setCreating(true)}
            empty={
              loading ? null : (
                <EmptyState
                  inline
                  title={t("sessionPage.emptyList")}
                  className="py-4"
                />
              )
            }
          />
        </aside>
      )}
      {showPane && (
        <div className="min-w-0 flex-1">
          {selected ? (
            <SessionPane
              item={selected}
              onBack={compact ? () => select(null) : undefined}
              clearOfCluster={!compact}
            />
          ) : (
            <EmptyState
              className="h-full"
              icon={<MessagesSquare />}
              title={t("sessionPage.empty")}
            />
          )}
        </div>
      )}
      {workspaceId !== null && (
        <NewSessionDialog
          open={creating}
          onOpenChange={setCreating}
          workspaceId={workspaceId}
          onStarted={refresh}
        />
      )}
    </section>
  );
}
