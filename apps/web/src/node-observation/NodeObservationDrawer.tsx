import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Crosshair, X } from "lucide-react";
import type { CanvasNode } from "@armadra/shared";

import { displayOfStatus, lineOf } from "../agent/display";
import { useProgramStatusStore } from "../agent/program-status-store";
import {
  useAgentStatusStore,
  type MirroredStatus,
} from "../agent/status-store";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { NODE_META } from "../nodes/registry";
import { WorkPanelSheet } from "../panels/WorkPanelSheet";
import { gotoNode } from "../sidebar/goto-node";
import { scoped } from "../sources/scope";
import { useCanvasStore } from "../store/canvas-store";
import { Loadable } from "@/loading/Loadable";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { SkeletonList } from "@/ui/skeletons";
import { StatusLine } from "@/ui/status-pill";
import { cn } from "@/lib/cn";
import { nodeTreeRows } from "./tree";

function isAgent(
  node: CanvasNode,
  status: MirroredStatus | undefined,
): boolean {
  return (
    node.data.kind === "terminal" &&
    (node.data.agent !== undefined || status !== undefined)
  );
}

/** The open canvas is the sole inventory; selecting a row never moves the camera. */
export function NodeObservationDrawer() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.observation);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const sourceId = useCanvasStore((state) => state.sourceId);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const statuses = useAgentStatusStore((state) => state.statuses);
  const programs = useProgramStatusStore((state) => state.programs);
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const documentReady =
    document?.board.id === boardId &&
    document?.board.workspaceId === workspaceId;
  const nodes = useMemo(
    () => (documentReady && document ? document.nodes : []),
    [document, documentReady],
  );
  const rows = useMemo(() => nodeTreeRows(nodes), [nodes]);
  const selected = nodes.find((node) => node.id === detailNodeId) ?? null;
  const nodeStatus = (node: CanvasNode) => {
    const status = statuses[scoped(node.id, sourceId)];
    return status?.workspaceId === workspaceId ? status : undefined;
  };
  const selectedStatus = selected ? nodeStatus(selected) : undefined;
  // 状态的色调与文案和节点头、侧栏、铃铛是同一个 `sessionDisplay()` 的结果（S2/S6）。
  const stateOf = (node: CanvasNode, status: MirroredStatus | undefined) =>
    lineOf(
      displayOfStatus(status, programs[scoped(node.id, sourceId)]),
      status?.activity,
      t,
    );
  const selectedState = selected ? stateOf(selected, selectedStatus) : null;

  useEffect(() => setDetailNodeId(null), [workspaceId, boardId, sourceId]);
  useEffect(() => {
    if (mode === "closed") setDetailNodeId(null);
  }, [mode]);
  useEffect(() => {
    if (detailNodeId && !selected) setDetailNodeId(null);
  }, [detailNodeId, selected]);

  const close = () => setPanel("observation", "closed");
  const locate = (node: CanvasNode) => {
    if (!nodes.some((current) => current.id === node.id)) return;
    close();
    gotoNode(node.boardId, node.id);
  };
  return (
    <WorkPanelSheet
      panel="observation"
      open={mode === "drawer"}
      onClose={close}
      label={t("nodeObservation.open")}
    >
      <div className="flex h-(--row-h-table) shrink-0 items-center gap-1 border-b border-border px-3">
        {selected && (
          <IconButton
            label={t("nodeObservation.back")}
            onClick={() => setDetailNodeId(null)}
          >
            <ArrowLeft />
          </IconButton>
        )}
        <SheetTitle className="min-w-0 flex-1 truncate text-body font-semibold">
          {selected?.title ?? t("nodeObservation.open")}
        </SheetTitle>
        <IconButton label={t("nodeObservation.close")} onClick={close}>
          <X />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {selected ? (
          <div className="flex flex-col gap-(--space-block) p-(--space-block)">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">
                {selected.title}
              </span>
              {selectedState && isAgent(selected, selectedStatus) && (
                <StatusLine
                  className="w-auto shrink-0"
                  tone={selectedState.tone}
                  label={selectedState.phaseLabel}
                  detail={selectedState.detail}
                  since={selectedState.since}
                  spinning={selectedState.spinning}
                />
              )}
            </div>
            <div className="flex flex-col gap-(--space-group) text-caption text-muted-foreground">
              <div>{t(NODE_META[selected.type].labelKey)}</div>
              {selected.parentId && (
                <div>
                  {t("nodeObservation.group")}:{" "}
                  {nodes.find((node) => node.id === selected.parentId)?.title ??
                    "—"}
                </div>
              )}
              {selectedStatus?.updatedAt && (
                <div>
                  {t("nodeObservation.lastUpdate")}:{" "}
                  {formatRelativeTime(selectedStatus.updatedAt)}
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => locate(selected)}
            >
              <Crosshair />
              {t("nodeObservation.locate")}
            </Button>
          </div>
        ) : (
          <Loadable
            loading={boardId !== null && !documentReady}
            skeleton={
              <SkeletonList
                rows={3}
                size="tall"
                leading="icon"
                trailing
                label={t("state.loading")}
              />
            }
            empty={rows.length === 0}
            emptyTitle={t("nodeObservation.empty")}
            inline
          >
            <div className="pb-3">
              <div className="px-4 py-2 text-caption text-muted-foreground">
                {t("nodeObservation.count", { count: rows.length })}
              </div>
              {rows.map(({ node, depth }) => {
                const meta = NODE_META[node.type];
                const Icon = meta.icon;
                const status = nodeStatus(node);
                const active = selectedNodeIds.includes(node.id);
                const agent = isAgent(node, status);
                const state = stateOf(node, status);
                return (
                  <Button
                    key={node.id}
                    variant="ghost"
                    size="sm"
                    aria-pressed={active}
                    className={cn(
                      "h-auto min-h-12 w-full min-w-0 justify-start rounded-none border-b border-border px-3 py-2 text-left font-normal",
                      active && "bg-brand-soft",
                    )}
                    style={{ paddingLeft: 12 + Math.min(depth, 6) * 16 }}
                    onClick={() => {
                      selectNodes([node.id]);
                      setDetailNodeId(node.id);
                    }}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {node.title}
                    </span>
                    {agent && (
                      <StatusLine
                        compact
                        className="w-auto shrink-0"
                        tone={state.tone}
                        label={state.phaseLabel}
                        spinning={state.spinning}
                      />
                    )}
                  </Button>
                );
              })}
            </div>
          </Loadable>
        )}
      </ScrollArea>
    </WorkPanelSheet>
  );
}
