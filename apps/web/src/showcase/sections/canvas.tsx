import * as React from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  MousePointer2,
  WifiOff,
} from "lucide-react";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import "@xyflow/react/dist/style.css";
import "../../styles/canvas.css";
import { useT } from "@/app/preferences-store";
import { agentColorVar } from "@/agent/launch";
import { edgeKey, useDeliveryStore } from "@/agent/delivery-store";
import { edgeTypes } from "@/canvas/flow/edges/edge-types";
import { useFamilies } from "@/canvas/family";
import {
  MinimapNode,
  MinimapToggle,
  minimapFill,
  minimapItemOf,
  minimapStroke,
} from "@/canvas/flow/Minimap";
import type { CanvasFlowNode } from "@/canvas/sync/project";
import { useCanvasStore } from "@/store/canvas-store";
import GroupNode from "@/canvas/flow/nodes/GroupNode";
import { NodeShell } from "@/nodes/NodeShell";
import { StickyNode } from "@/nodes/StickyNode";
import { Banner } from "@/shell/Banners";
import { Badge } from "@/ui/badge";
import { ColorDot } from "@/ui/color-dot";
import { memberColorVar } from "@/ui/member-dot";
import {
  BANNER_SAMPLES,
  CANVAS_EDGES,
  CANVAS_IDS,
  CANVAS_NODES,
  CLUSTER_EDGES,
  CLUSTER_NODES,
  FOLLOW_EDGES,
  FOLLOW_NODES,
  STATE_IDS,
  STATE_NODES,
  DELIVERY,
  EDITOR_LINES,
  PEERS,
  PINS,
  TERMINAL_LINES,
} from "../fixtures/canvas";

/**
 * `canvas` 分区（设计展示页 §2.1，设计系统 §4）：600×400 的假画布。
 *
 * 节点外壳、状态胶囊、光晕、分组、两种边都是画布上的真组件；节点体换成
 * 静态内容——真终端要连 core，真编辑器要读文件，展示页两样都不碰。
 * 他人光标、选区与评论钉是多人协同（设计系统 §5.6–§5.7）的视觉，按 §4 的
 * 表画在节点之上的一层（`--z-canvas-overlay`）。
 */

type ShowcaseFlowNode = Node<CanvasNode, "showcase" | "group">;

const WIDTH = 600;
const HEIGHT = 400;

function TerminalBody() {
  return (
    <div
      className="h-full bg-term px-3 py-2 font-mono text-meta leading-[1.5]"
      style={{ color: "var(--term-fg)" }}
    >
      {TERMINAL_LINES.map((line) => (
        <div key={line} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  );
}

function EditorBody() {
  return (
    <div className="h-full px-3 py-2 font-mono text-meta leading-[1.5]">
      {EDITOR_LINES.map((line) => (
        <div key={line} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  );
}

/** 真的便签正文：顶部 3px 色条 + 10% 混色底 + 等宽底栏。 */
function StickyBody({ node }: { node: CanvasNode }) {
  return (
    <StickyNode
      id={node.id}
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />
  );
}

/** 其他人选中这个节点：1.5px 虚线成员色，外扩 2px（设计系统 §4）。 */
function peerSelection(id: string): string | undefined {
  const peer = PEERS.find((candidate) => candidate.selects === id);
  return peer ? memberColorVar(peer.member) : undefined;
}

function ShowcaseNode({ data: node }: NodeProps<ShowcaseFlowNode>) {
  const t = useT();
  const peer = peerSelection(node.id);
  const body =
    node.data.kind === "terminal" ? (
      <TerminalBody />
    ) : node.data.kind === "editor" ? (
      <EditorBody />
    ) : node.data.kind === "sticky" ? (
      <StickyBody node={node} />
    ) : null;
  const working = node.id === CANVAS_IDS.terminal;
  const unread = node.id === CANVAS_IDS.editor;
  return (
    <div
      className="h-full w-full rounded-card"
      style={
        peer ? { outline: `1.5px dashed ${peer}`, outlineOffset: 2 } : undefined
      }
    >
      <NodeShell
        node={node}
        selected={false}
        {...(working
          ? {
              glow: "working" as const,
              status: {
                tone: "working" as const,
                label: t("showcase.tone.working"),
              },
              headerMark: <ColorDot color={agentColorVar("claude")} size={8} />,
            }
          : {})}
        {...(unread
          ? {
              glow: "unread" as const,
              status: {
                tone: "unread" as const,
                label: t("showcase.tone.unread"),
              },
            }
          : {})}
      >
        {body}
      </NodeShell>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  showcase: ShowcaseNode,
  group: GroupNode,
};

const flowNodes: ShowcaseFlowNode[] = CANVAS_NODES.map((node) => ({
  id: node.id,
  type: node.type === "group" ? "group" : "showcase",
  position: node.position,
  data: node,
  width: node.size?.width,
  height: node.size?.height,
  zIndex: node.type === "group" ? 0 : 1,
  draggable: false,
  selectable: false,
  dragHandle: ".drag-handle",
}));

const flowEdges: Edge[] = CANVAS_EDGES.map((edge) => ({
  ...edge,
  data: { ...edge.data },
  selectable: false,
}));

/** 他人光标：16px 箭头成员色 + 右下名字标签（设计系统 §4）。 */
function PeerCursor({
  member,
  name,
  x,
  y,
}: {
  member: number;
  name: string;
  x: number;
  y: number;
}) {
  const color = memberColorVar(member);
  return (
    <div
      data-peer-cursor
      className="pointer-events-none absolute flex items-start"
      style={{ transform: `translate(${x}px, ${y}px)`, left: 0, top: 0 }}
    >
      <MousePointer2 className="size-4" style={{ color, fill: color }} />
      <span
        className="mt-3 rounded-pill border bg-card px-1.5 text-caption leading-4"
        style={{ borderColor: color }}
      >
        {name}
      </span>
    </div>
  );
}

/** 评论钉：24px 圆、`--card` 底、2px 成员色边、里面是计数（设计系统 §4）。 */
function CommentPin({
  member,
  x,
  y,
  count,
  resolved,
}: {
  member: number;
  x: number;
  y: number;
  count: number;
  resolved: boolean;
}) {
  return (
    <div
      data-comment-pin={resolved ? "resolved" : "open"}
      className="pointer-events-none absolute flex size-6 items-center justify-center rounded-pill border-2 bg-card text-caption font-medium tabular-nums"
      style={{
        left: x - 12,
        top: y - 12,
        borderColor: resolved ? "var(--faint)" : memberColorVar(member),
        color: resolved ? "var(--faint)" : undefined,
      }}
    >
      {count}
      {resolved ? null : (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-pill bg-brand" />
      )}
    </div>
  );
}

/* ------------------------- 节点头：全部常显（§4） ------------------------- */

/** ≥ 560 宽状态段出 `StatusPill sm`；更窄只画 `StatusDot 8`。 */
const HEADER_WIDTHS = [600, 480] as const;
const HEADER_HEIGHT_PX = 72;

/** 一个头部塞满的终端：名字、三枚胶囊加一枚折叠计数、状态、审批、动作。 */
function headerNodeOf(width: number): CanvasNode {
  return {
    ...(CANVAS_NODES.find((node) => node.id === CANVAS_IDS.terminal) ??
      CANVAS_NODES[0]!),
    id: `00000000-0000-4000-8000-0000000000f${width}`,
    position: { x: 0, y: 0 },
    size: { width, height: HEADER_HEIGHT_PX },
    data: {
      kind: "terminal",
      agent: { id: "claude" },
      handle: "reviewer",
    } as CanvasNode["data"],
  };
}

function HeaderSpecimenNode({ data: node }: NodeProps<ShowcaseFlowNode>) {
  const t = useT();
  return (
    <NodeShell
      node={node}
      selected={false}
      headerMark={<ColorDot color={agentColorVar("claude")} size={8} />}
      headerChips={
        <>
          <Badge variant="outline" size="sm">
            6.6 MB
          </Badge>
          <Badge variant="outline" size="sm">
            {t("delivery.queued", { count: 2 })}
          </Badge>
          <Badge variant="outline" size="sm">
            {t("contextReads.count", { count: 3 })}
          </Badge>
          <Badge variant="destructive" size="sm">
            exit 1
          </Badge>
        </>
      }
      status={{ tone: "attention", label: t("showcase.tone.attention") }}
      approval={{ pendingId: "showcase", onAnswer: () => undefined }}
    >
      <TerminalBody />
    </NodeShell>
  );
}

const headerNodeTypes: NodeTypes = { showcase: HeaderSpecimenNode };

function headerFlowNodesOf(width: number): ShowcaseFlowNode[] {
  const node = headerNodeOf(width);
  return [
    {
      id: node.id,
      type: "showcase",
      position: { x: 0, y: 0 },
      data: node,
      width,
      height: HEADER_HEIGHT_PX,
      draggable: false,
      selectable: false,
      dragHandle: ".drag-handle",
    },
  ];
}

const headerFlowNodes = new Map<number, ShowcaseFlowNode[]>(
  HEADER_WIDTHS.map((width) => [width, headerFlowNodesOf(width)]),
);

/** 节点头四段的固定状态：不悬停、不选中，所有控件也都在（设计系统 §4）。 */
function HeaderSpecimen({ scale, width }: { scale: number; width: number }) {
  return (
    <div style={{ height: (HEADER_HEIGHT_PX + 2) * scale }}>
      <div
        data-showcase-node-header={width}
        className="canvas-stage relative origin-top-left overflow-hidden rounded-panel border border-border"
        style={{
          width: width + 2,
          height: HEADER_HEIGHT_PX + 2,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      >
        {/* 自己的 provider：展示页外层那一个归上面的假画布，共用会互相覆盖节点。 */}
        <ReactFlowProvider>
          <ReactFlow
            nodes={headerFlowNodes.get(width) ?? []}
            edges={[]}
            nodeTypes={headerNodeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

/* ------------------------- 节点状态：平时 / 选中 / 拖动 ------------------------- */

const STATE_HEIGHT = 160;

function StateNodeView({ data: node }: NodeProps<ShowcaseFlowNode>) {
  return (
    <div
      data-slot="node-host"
      data-dragging={node.id === STATE_IDS.dragging ? "true" : undefined}
      className="contents"
    >
      <NodeShell node={node} selected={node.id === STATE_IDS.selected}>
        <StickyBody node={node} />
      </NodeShell>
    </div>
  );
}

const stateNodeTypes: NodeTypes = { showcase: StateNodeView };

const stateFlowNodes: ShowcaseFlowNode[] = STATE_NODES.map((node) => ({
  id: node.id,
  type: "showcase",
  position: node.position,
  data: node,
  width: node.size.width,
  height: node.size.height,
  draggable: false,
  selectable: false,
  dragHandle: ".drag-handle",
}));

function StateSpecimen({ scale }: { scale: number }) {
  return (
    <div style={{ height: (STATE_HEIGHT + 2) * scale }}>
      <div
        data-showcase-node-states
        className="canvas-stage relative origin-top-left overflow-hidden rounded-panel border border-border"
        style={{
          width: WIDTH + 2,
          height: STATE_HEIGHT + 2,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={stateFlowNodes}
            edges={[]}
            nodeTypes={stateNodeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--canvas-dot)"
              gap={20}
            />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

/* ----------------------------- 横幅：四档语气 ----------------------------- */

const BANNER_ICON = {
  danger: <WifiOff />,
  warn: <AlertTriangle />,
  success: <CheckCircle2 />,
  info: <Info />,
} as const;

function BannerSpecimen() {
  return (
    <div data-showcase-banners className="flex flex-col items-start gap-2">
      {BANNER_SAMPLES.map((sample) => (
        <Banner
          key={sample.tone}
          tone={sample.tone}
          icon={BANNER_ICON[sample.tone]}
          text={sample.text}
          {...(sample.action
            ? { actionLabel: sample.action, onAction: () => undefined }
            : {})}
          onDismiss={() => undefined}
        />
      ))}
    </div>
  );
}

/* ------------------------------ 簇色固定状态 ------------------------------ */

const CLUSTER_WIDTH = 600;
const CLUSTER_HEIGHT = 330;

/**
 * 簇色读的是 canvas-store 里的文档（`family.ts`）。展示页没有真画布，挂载时把
 * 两块假画布的节点与边写进去，卸载时还原。
 */
const SHOWCASE_DOCUMENT: BoardDocument = {
  board: {} as BoardDocument["board"],
  nodes: [...CANVAS_NODES, ...CLUSTER_NODES, ...FOLLOW_NODES],
  edges: [
    ...CANVAS_EDGES.filter((edge) => edge.type === "link").map((edge) => ({
      id: edge.id,
      boardId: CLUSTER_EDGES[0]!.boardId,
      kind: "link" as const,
      source: edge.source,
      target: edge.target,
      ...("role" in edge.data ? { role: edge.data.role } : {}),
      createdAt: CLUSTER_EDGES[0]!.createdAt,
      updatedAt: CLUSTER_EDGES[0]!.updatedAt,
    })),
    ...CLUSTER_EDGES,
    ...FOLLOW_EDGES,
  ],
};

function ClusterNode({ data: node }: NodeProps<ShowcaseFlowNode>) {
  return (
    <NodeShell
      node={node}
      selected={false}
      {...(node.data.kind === "terminal"
        ? {
            headerMark: (
              <ColorDot color={agentColorVar(node.data.agent?.id)} size={8} />
            ),
          }
        : {})}
    >
      {null}
    </NodeShell>
  );
}

const clusterNodeTypes: NodeTypes = { armadra: ClusterNode };

function specimenNodes(nodes: readonly CanvasNode[]) {
  return nodes.map((node) => ({
    id: node.id,
    type: "armadra" as const,
    position: node.position,
    data: node,
    width: node.size?.width,
    height: node.size?.height,
    draggable: false,
    selectable: false,
    dragHandle: ".drag-handle",
  }));
}

function specimenEdges(edges: typeof CLUSTER_EDGES): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    type: "link",
    source: edge.source,
    target: edge.target,
    data: { role: edge.role },
    selectable: false,
  }));
}

const clusterFlowNodes = specimenNodes(CLUSTER_NODES);
const clusterFlowEdges = specimenEdges(CLUSTER_EDGES);
const followFlowNodes = specimenNodes(FOLLOW_NODES);
const followFlowEdges = specimenEdges(FOLLOW_EDGES);

const noGlow = () => undefined;

/**
 * 两簇 + 独立 Agent + 便签，配一张同色的小地图（设计 ui-wave2 §5.4）。上下文线
 * （便签 ↔ reviewer、reviewer ↔ worker）是专用的品红，派发线是各自的簇色，小地图里
 * 两类线同样分色，锚点与曲线也同画布（#216）。右上角的「−」定格在悬停时那一刻。
 */
const noop = () => {};

/** 小地图的尺寸与位置变量：真画布的位置规则（`styles/canvas.css`）读它们。 */
const MINIMAP_VARS = {
  "--minimap-w": "150px",
  "--minimap-h": "90px",
  "--navigation-bottom": "10px",
} as React.CSSProperties;

function ClusterSpecimen({ scale }: { scale: number }) {
  const families = useFamilies();
  return (
    <div style={{ height: (CLUSTER_HEIGHT + 2) * scale }}>
      <div
        data-showcase-clusters
        className="canvas-stage relative origin-top-left overflow-hidden rounded-panel border border-border"
        style={{
          ...MINIMAP_VARS,
          width: CLUSTER_WIDTH + 2,
          height: CLUSTER_HEIGHT + 2,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={clusterFlowNodes}
            edges={clusterFlowEdges}
            nodeTypes={clusterNodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--canvas-dot)"
              gap={20}
            />
            <MiniMap<CanvasFlowNode>
              // SVG 的尺寸读 width / height；展示页没有 Dock，贴着右下角放一张小的。
              style={{ width: 150, height: 90 }}
              nodeColor={(node) =>
                minimapFill(minimapItemOf(node, noGlow, families))
              }
              nodeStrokeColor={(node) =>
                minimapStroke(minimapItemOf(node, noGlow, families))
              }
              nodeComponent={MinimapNode}
              nodeBorderRadius={3}
            />
            <MinimapToggle collapsed={false} onToggle={noop} reveal />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

/**
 * 连线随动（#211）：主在中间，四条线从它的四条边各出一条。拖动节点时每条线按
 * 两端此刻的相对位置重新选边；这里把「拖过之后」的那一刻定格下来。右下角是
 * 小地图收起后的展开钮（#216）。
 */
function FollowSpecimen({ scale }: { scale: number }) {
  return (
    <div style={{ height: (CLUSTER_HEIGHT + 2) * scale }}>
      <div
        data-showcase-follow
        className="canvas-stage relative origin-top-left overflow-hidden rounded-panel border border-border"
        style={{
          ...MINIMAP_VARS,
          width: CLUSTER_WIDTH + 2,
          height: CLUSTER_HEIGHT + 2,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={followFlowNodes}
            edges={followFlowEdges}
            nodeTypes={clusterNodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--canvas-dot)"
              gap={20}
            />
            <MinimapToggle collapsed onToggle={noop} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

export default function CanvasSection() {
  // 簇色从 canvas-store 读：挂载期间换成展示用的文档，卸载时还原。
  React.useEffect(() => {
    const previous = useCanvasStore.getState().document;
    useCanvasStore.setState({ document: SHOWCASE_DOCUMENT });
    return () => useCanvasStore.setState({ document: previous });
  }, []);

  // 投递流光只在「刚投递」的两秒内画；展示页把时刻放到未来，让它一直亮着。
  React.useEffect(() => {
    const key = edgeKey(DELIVERY.source, DELIVERY.target);
    useDeliveryStore.setState({
      marks: {
        [key]: {
          sourceNodeId: DELIVERY.source,
          targetNodeId: DELIVERY.target,
          outcome: "delivered",
          at: Date.now() + 10 * 60_000,
        },
      },
    });
    return () => useDeliveryStore.getState().reset();
  }, []);

  // 手机宽度下整块等比缩小（只缩显示，画布坐标不变），不出横向滚动。
  const frame = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () =>
      setScale(Math.min(1, element.clientWidth / (WIDTH + 2)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frame} className="flex flex-col gap-4">
      <div style={{ height: (HEIGHT + 2) * scale }}>
        <div
          data-showcase-canvas
          className="canvas-stage relative origin-top-left overflow-hidden rounded-panel border border-border"
          style={{
            width: WIDTH + 2,
            height: HEIGHT + 2,
            transform: scale < 1 ? `scale(${scale})` : undefined,
          }}
        >
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="var(--canvas-dot)"
              gap={20}
            />
          </ReactFlow>
          <div
            className="pointer-events-none absolute inset-0"
            style={{ zIndex: "var(--z-canvas-overlay)" }}
          >
            {PINS.map((pin) => (
              <CommentPin key={`${pin.x}-${pin.y}`} {...pin} />
            ))}
            {PEERS.map((peer) => (
              <PeerCursor
                key={peer.member}
                member={peer.member}
                name={peer.name}
                x={peer.cursor.x}
                y={peer.cursor.y}
              />
            ))}
          </div>
        </div>
      </div>
      {HEADER_WIDTHS.map((width) => (
        <HeaderSpecimen key={width} scale={scale} width={width} />
      ))}
      <StateSpecimen scale={scale} />
      <BannerSpecimen />
      <ClusterSpecimen scale={scale} />
      <FollowSpecimen scale={scale} />
    </div>
  );
}
