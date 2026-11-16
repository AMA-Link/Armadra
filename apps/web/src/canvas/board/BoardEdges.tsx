import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import { labelFontSize, LABEL_MIN_ZOOM, midpointOf } from "@armadra/board/core";
import { useBoard, useCamera, WorldOverlay } from "@armadra/board/react";
import type { DomBoard } from "@armadra/board/dom";
import { X } from "lucide-react";

import { useDeliveryEdge } from "@/agent/delivery-store";
import { useT } from "@/app/preferences-store";
import { useFamilyColor } from "@/canvas/family";
import { displayNameOf } from "@/canvas/supervision";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { removeContentReference } from "../create-content-reference";
import { useLayoutDirection } from "../layout-direction";
import { EdgeLabel } from "../flow/edges/EdgeLabel";
import { deliveryTooltip, supervisionTooltip } from "../flow/edges/LinkEdge";
import {
  arrowHead,
  linkColor,
  STROKE_WIDTH,
  STROKE_WIDTH_SELECTED,
} from "../flow/edges/link-visual";
import { edgeDataOf, LINK_KIND } from "./edge-model";
import {
  edgeRouterFor,
  type EdgeLayout,
  type LayoutParams,
} from "./edge-layout";
import { setEdgeTooltip } from "./edge-hover";

/**
 * 自研引擎下的连线层（B4）：一张世界坐标的 SVG，跟相机同一个变换。
 *
 * 画法、颜色、箭头、标签、投递流动与旧引擎的 `LinkEdge` / `ReferenceEdge` 一致
 * （同一组 `link-visual` 函数与同一个布局核心）。区别只有交互：SVG 层不接指针，
 * 命中、选中、右键、悬停提示由 `edge-hover.ts` 与 `BoardWorkspace` 用几何
 * （折线距离）完成，不再给每条线铺一条加粗的透明命中路径。
 */

/** 标签字号只订阅到整数：缩放手势每一帧都在变，标签只在字号变了时重摆。 */
function useLabelFont(): number {
  return useCamera((camera) =>
    camera.zoom < LABEL_MIN_ZOOM ? 0 : labelFontSize(camera.zoom),
  );
}

export function useBoardEdgeLayout(id: string): EdgeLayout | null {
  const board = useBoard<CanvasNode>();
  const router = edgeRouterFor(board);
  const t = useT();
  const direction = useLayoutDirection();
  const fontSize = useLabelFont();
  const read = React.useCallback(
    () => router.read(id, { direction, fontSize, t } satisfies LayoutParams),
    [router, id, direction, fontSize, t],
  );
  return React.useSyncExternalStore(router.subscribe, read, read);
}

/** 场景里全部连线的 id；没增减时拿到同一个数组。 */
function useEdgeIds(board: DomBoard<CanvasNode>): readonly string[] {
  const state = React.useMemo(() => {
    let ordered: readonly unknown[] | null = null;
    let ids: readonly string[] = [];
    return {
      get(): readonly string[] {
        const next = board.scene.ordered();
        if (next === ordered) return ids;
        ordered = next;
        const fresh = next.filter((e) => e.ends).map((e) => e.id);
        if (fresh.length !== ids.length || fresh.some((v, i) => v !== ids[i])) {
          ids = fresh;
        }
        return ids;
      },
    };
  }, [board]);
  return React.useSyncExternalStore(
    board.scene.subscribe,
    state.get,
    state.get,
  );
}

export function BoardEdges() {
  const board = useBoard<CanvasNode>();
  const ids = useEdgeIds(board);
  return (
    <>
      <WorldOverlay layer="svg">
        <g data-slot="board-edges">
          {ids.map((id) => (
            <BoardEdge key={id} id={id} />
          ))}
        </g>
      </WorldOverlay>
    </>
  );
}

function BoardEdge({ id }: { id: string }) {
  const { scene } = useBoard<CanvasNode>();
  const entity = scene.get(id);
  if (!entity) return null;
  return edgeDataOf(entity).type === LINK_KIND ? (
    <LinkLine id={id} source={entity.ends![0]} target={entity.ends![1]} />
  ) : (
    <ReferenceLine id={id} />
  );
}

function useEdgeSelected(id: string): boolean {
  return useCanvasStore((state) => state.selectedEdgeIds.includes(id));
}

function nodeNameOf(board: DomBoard<CanvasNode>, id: string): string {
  const node = board.scene.get(id)?.data as CanvasNode | undefined;
  return displayNameOf(node, id);
}

const LinkLine = React.memo(function LinkLine({
  id,
  source,
  target,
}: {
  id: string;
  source: string;
  target: string;
}) {
  const t = useT();
  const board = useBoard<CanvasNode>();
  const selected = useEdgeSelected(id);
  const familyColor = useFamilyColor(source);
  const layout = useBoardEdgeLayout(id);
  const { mark, flashing } = useDeliveryEdge(source, target);
  const role = edgeDataOf(board.scene.get(id)!).role;
  const supervision = supervisionTooltip(
    role,
    nodeNameOf(board, source),
    nodeNameOf(board, target),
    t,
  );
  const tooltip =
    [supervision, deliveryTooltip(mark, t)].filter(Boolean).join("\n") || null;
  React.useEffect(() => {
    setEdgeTooltip(id, tooltip);
    return () => setEdgeTooltip(id, null);
  }, [id, tooltip]);

  const supervises = role === "supervises";
  if (!layout) return null;
  const { view, text: label, label: labelBox } = layout;
  const { route, d, arrowStart, arrowEnd } = view;
  const points = route.points;
  const width = selected ? STROKE_WIDTH_SELECTED : STROKE_WIDTH;
  const color = linkColor({ supervises, familyColor, selected, flashing });
  return (
    <g
      style={{ color }}
      data-slot="link-edge"
      data-edge-id={id}
      data-delivery={flashing ? "true" : undefined}
      data-role={supervises ? "supervises" : undefined}
    >
      {tooltip === null ? null : <title>{tooltip}</title>}
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        style={{
          strokeWidth: flashing ? width + 1 : width,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
      {flashing ? (
        <path
          className="anim-delivery-flow"
          d={d}
          fill="none"
          stroke="currentColor"
          style={{ strokeWidth: width + 1 }}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="6 10"
          pointerEvents="none"
        />
      ) : null}
      {arrowStart ? (
        <path
          d={arrowHead(points[0]!, points[1]!)}
          fill="none"
          stroke="currentColor"
          style={{ strokeWidth: width }}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {arrowEnd ? (
        <path
          d={arrowHead(points[points.length - 1]!, points[points.length - 2]!)}
          fill="none"
          stroke="currentColor"
          style={{ strokeWidth: width }}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {labelBox ? <EdgeLabel box={labelBox} text={label} /> : null}
    </g>
  );
});

const ReferenceLine = React.memo(function ReferenceLine({
  id,
}: {
  id: string;
}) {
  const selected = useEdgeSelected(id);
  const layout = useBoardEdgeLayout(id);
  if (!layout) return null;
  const { route } = layout.view;
  const { text: label, label: labelBox } = layout;
  const points = route.points;
  const to = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const middle = midpointOf(points);
  const width = selected ? STROKE_WIDTH : STROKE_WIDTH - 0.5;
  const color = selected ? "var(--brand)" : "var(--muted-foreground)";
  return (
    <>
      <g style={{ color }} data-slot="reference-edge" data-edge-id={id}>
        <path
          d={layout.view.d}
          fill="none"
          stroke="currentColor"
          style={{
            strokeWidth: width,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            strokeDasharray: "6 5",
            opacity: selected ? 1 : 0.75,
          }}
        />
        <path
          d={arrowHead(to, before)}
          fill="none"
          stroke="currentColor"
          style={{ strokeWidth: width }}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={selected ? 1 : 0.75}
        />
        {labelBox && !selected ? (
          <EdgeLabel box={labelBox} text={label} />
        ) : null}
      </g>
      {selected ? (
        <WorldOverlay>
          <ReferenceRemove
            id={id}
            x={labelBox?.x ?? middle.x}
            y={labelBox?.y ?? middle.y}
          />
        </WorldOverlay>
      ) : null}
    </>
  );
});

/** 选中的引用边中点上的删除钮（引用不在 `document.edges`，Delete 键删不掉它）。 */
function ReferenceRemove({ id, x, y }: { id: string; x: number; y: number }) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="secondary"
          size="icon-xs"
          aria-label={t("shape.removeReference")}
          data-slot="reference-remove"
          className="nodrag nopan pointer-events-auto absolute shadow-overlay"
          style={{
            transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          }}
          onClick={(event) => {
            event.stopPropagation();
            removeContentReference(id);
          }}
        >
          <X />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("shape.removeReference")}</TooltipContent>
    </Tooltip>
  );
}
