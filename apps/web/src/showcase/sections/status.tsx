import * as React from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import "@xyflow/react/dist/style.css";
import "../../styles/canvas.css";
import { displayOfStatus, lineOf } from "@/agent/display";
import { useAgentStatusStore, type MirroredStatus } from "@/agent/status-store";
import { useSubagentStore } from "@/agent/subagent-store";
import { useT } from "@/app/preferences-store";
import { AgentActivityNode } from "@/nodes/AgentActivityNode";
import { SubagentCard } from "@/nodes/SubagentCard";
import { NeedRow } from "@/notifications/NotificationPanel";
import { SessionRow } from "@/sessions/SessionRow";
import { scoped } from "@/sources/scope";
import { useCanvasStore } from "@/store/canvas-store";
import { AgentTree } from "@/ui/agent-tree";
import { StatusDot, StatusLine, StatusPill } from "@/ui/status-pill";
import {
  ACTIVITY_NODE,
  ACTIVITY_WORLD,
  NEED_ITEMS,
  SESSION_ROWS,
  SUBAGENT_CARDS,
  TONES,
  TREE_FIXTURES,
  mirroredFor,
} from "../fixtures/status";
import { Sample } from "./sample";

/**
 * `status` 分区（设计展示页 §2.1，设计系统 §11.1）：
 *
 *  1. 八个 tone × 三种形态（`StatusDot` / `StatusPill` / `StatusLine`）的矩阵；
 *  2. 缩略 Agent 树 sm / md 五种夹具（1 层 / 3 层 / 超出 `+k` / 全 idle / 混合 tone）与一条折叠；
 *  3. 四种状态载体：活动卡、子代理卡、会话行、通知行——都是真组件，数据来自假的
 *     画布文档、状态镜像与子代理卡片（挂载期间写进各自的 store，卸载还原）。
 */

/** 挂载期间把假世界写进三个 store；`ready` 之后才渲染读它们的组件。 */
function useStatusWorld(): boolean {
  const [ready, setReady] = React.useState(false);
  React.useLayoutEffect(() => {
    const previous = {
      document: useCanvasStore.getState().document,
      statuses: useAgentStatusStore.getState().statuses,
      cards: useSubagentStore.getState().cards,
    };
    useCanvasStore.setState({
      document: {
        board: {} as BoardDocument["board"],
        nodes: ACTIVITY_WORLD.nodes,
        edges: ACTIVITY_WORLD.edges,
      } as unknown as BoardDocument,
    });
    useAgentStatusStore.setState({
      statuses: Object.fromEntries(
        Object.entries(ACTIVITY_WORLD.statuses).map(([id, status]) => [
          scoped(id),
          status,
        ]),
      ),
    });
    useSubagentStore.setState({
      cards: Object.fromEntries(
        Object.entries(ACTIVITY_WORLD.cards).map(([id, cards]) => [
          scoped(id),
          cards,
        ]),
      ),
    });
    setReady(true);
    return () => {
      useCanvasStore.setState({ document: previous.document });
      useAgentStatusStore.setState({ statuses: previous.statuses });
      useSubagentStore.setState({ cards: previous.cards });
    };
  }, []);
  return ready;
}

/** 八个 tone × 三种形态：同一个 tone 同一句文案（文案经 `lineOf`，与别处同源）。 */
function Matrix() {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <table
        data-status-matrix
        className="border-separate border-spacing-x-4 border-spacing-y-2 text-left"
      >
        <thead>
          <tr>
            <th />
            {["dot 6", "dot 8", "pill sm", "pill md", "line"].map((name) => (
              <th
                key={name}
                scope="col"
                className="font-mono text-caption font-normal text-muted-foreground"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TONES.map((tone) => {
            const status: MirroredStatus | undefined = mirroredFor(
              "matrix",
              tone,
            );
            const line = lineOf(displayOfStatus(status), status?.activity, t);
            return (
              <tr key={tone} data-tone-row={tone}>
                <th
                  scope="row"
                  className="font-mono text-caption font-normal text-muted-foreground"
                >
                  {tone}
                </th>
                <td>
                  <StatusDot tone={tone} size={6} label={line.phaseLabel} />
                </td>
                <td>
                  <StatusDot tone={tone} size={8} label={line.phaseLabel} />
                </td>
                <td>
                  <StatusPill tone={tone} size="sm" label={line.phaseLabel} />
                </td>
                <td>
                  <StatusPill tone={tone} size="md" label={line.phaseLabel} />
                </td>
                <td className="min-w-48">
                  <StatusLine
                    tone={tone}
                    label={line.phaseLabel}
                    detail={tone === "working" ? "pnpm test" : undefined}
                    since={
                      tone === "working" || tone === "attention"
                        ? Date.now() - 12_000
                        : undefined
                    }
                    spinning={line.spinning}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Trees() {
  const three = TREE_FIXTURES[1]!;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-(--space-block)">
      {TREE_FIXTURES.map(({ name, tree }) => (
        <Sample key={name} name={name}>
          <div className="flex items-start gap-6">
            <div className="flex h-12 items-center rounded-card border border-border px-3">
              <AgentTree tree={tree} size="sm" />
            </div>
            <div className="w-60">
              <AgentTree tree={tree} size="md" />
            </div>
          </div>
        </Sample>
      ))}
      <Sample name="tree · md folded">
        <div className="w-60">
          <AgentTree
            tree={three.tree}
            size="md"
            defaultCollapsed={[three.tree.root.children[0]!.id]}
          />
        </div>
      </Sample>
    </div>
  );
}

type ActivityFlowNode = Node<CanvasNode, "activity">;

function ActivityView({ data: node }: NodeProps<ActivityFlowNode>) {
  return (
    <AgentActivityNode
      id={node.id}
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />
  );
}

const nodeTypes: NodeTypes = { activity: ActivityView };
const flowNodes: ActivityFlowNode[] = [
  {
    id: ACTIVITY_NODE.id,
    type: "activity",
    position: { x: 16, y: 16 },
    data: ACTIVITY_NODE,
    width: ACTIVITY_NODE.size?.width ?? 300,
    height: ACTIVITY_NODE.size?.height ?? 232,
    draggable: false,
    selectable: false,
  },
];

function ActivityFlow() {
  const width = (ACTIVITY_NODE.size?.width ?? 300) + 32;
  const height = (ACTIVITY_NODE.size?.height ?? 232) + 32;
  return (
    <div
      data-showcase-activity
      className="canvas-stage relative overflow-hidden rounded-panel border border-border"
      style={{ width, height }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={flowNodes}
          edges={[]}
          nodeTypes={nodeTypes}
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
  );
}

function States() {
  const t = useT();
  const ready = useStatusWorld();
  if (!ready) return null;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-(--space-block)">
      <Sample name="AgentActivityNode">
        <ActivityFlow />
      </Sample>
      <Sample name="SubagentCard" wide>
        <div className="flex w-full flex-col gap-2">
          {SUBAGENT_CARDS.map((card) => (
            <SubagentCard key={card.id} card={card} />
          ))}
        </div>
      </Sample>
      <Sample name="SessionRow">
        <div
          data-showcase-sessions
          className="w-72 rounded-panel border border-border bg-panel p-2"
        >
          {SESSION_ROWS.map((row) => (
            <SessionRow key={row.sessionId} row={row} />
          ))}
        </div>
      </Sample>
      <Sample name="NeedRow">
        <ul
          data-showcase-needs
          className="w-[360px] rounded-panel border border-border bg-panel p-2"
        >
          {NEED_ITEMS.map((item) => (
            <NeedRow
              key={item.key}
              item={item}
              label={t(`notifications.need.${item.need}`)}
              onSelect={() => undefined}
              onInspect={() => undefined}
            />
          ))}
        </ul>
      </Sample>
    </div>
  );
}

export default function StatusSection() {
  return (
    <div className="flex min-w-0 flex-col gap-(--space-block)">
      <Matrix />
      <Trees />
      <States />
    </div>
  );
}
