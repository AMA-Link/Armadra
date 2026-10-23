import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  AGENT_TREE_LEVEL_CAP,
  limitLevels,
  nodeLabel,
  summaryLabel,
  type AgentTree,
  type AgentTreeLevel,
  type AgentTreeNode,
} from "@/agent/agent-tree-model";
import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useRoving } from "@/ui/roving";
import { TONE_COLOR, type StatusTone } from "@/ui/status-pill";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/tooltip";

/**
 * 缩略 Agent 树（设计系统 §11.1，状态族第四件）：只表达「谁派了谁」与「各自什么
 * 状态」——状态色方块 + 1px 正交连线，不放模型、费用、耗时、任务描述。数据由
 * `agent/agent-tree-model.ts` 的 `agentTreeOf` 给；没有下级时调用方不渲染它。
 *
 * - `sm`：单个 SVG（≤ 96 × 48），放在行右侧；根 8 × 8、子节点 6 × 6，每层最多
 *   5 格（超出最后一格换成 `+k`），最多三层，更深的在末层方块右下角画一个 2px 点。
 *   整体一个焦点停留点，聚焦显示汇总提示；悬停某个方块显示「名称 · 状态」。
 * - `md`：宽 ≤ 240，12 × 12 方块 + 极短标签，每层最多 8 格；父节点可折叠成
 *   一行「名称 · +k」；顶行是汇总；节点之间 ↑↓ ← → 移动，回车折叠 / 展开。
 *
 * 颜色一律取状态族的 `TONE_COLOR`：`idle` 空心，`working / attention` 外圈按
 * `anim-dot-pulse` 呼吸（减少动效下静止，状态仍由颜色与提示文字表达）。
 */
export interface AgentTreeProps {
  tree: AgentTree;
  size: "sm" | "md";
  /** md：某个父节点折叠 / 展开时。 */
  onToggle?: (id: string, collapsed: boolean) => void;
  /** md：初始就折叠的节点 id。 */
  defaultCollapsed?: readonly string[];
  className?: string;
}

const PULSING: ReadonlySet<StatusTone> = new Set(["working", "attention"]);
const RING_CLASS = "anim-dot-pulse motion-reduce:animate-none";

/* ----------------------------------- sm ----------------------------------- */

export const SM_MAX_WIDTH = 96;
export const SM_MAX_HEIGHT = 48;
const SM_ROOT = 8;
const SM_CHILD = 6;
/** 每层方块上沿的 y：根、第二层、第三层（上方留 2px 给呼吸外圈）。 */
const SM_ROW_TOP = [2, 21, 35] as const;
/** 每层连线的母线 y（根下方竖线 6px，其后每层竖线 4px / 3px）。 */
const SM_BUS_Y = [16, 31] as const;
const SM_MORE_CHAR = 5.5;

export interface SmCell {
  id: string;
  /** 方块；`+k` 格没有。 */
  node?: AgentTreeNode;
  /** `+k` 格的 k。 */
  overflow?: number;
  level: number;
  /** 方块中心 x（整数像素）。 */
  cx: number;
  top: number;
  size: number;
  /** 父格的 id（画连线用）。 */
  parent?: string;
}

export interface SmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SmLayout {
  width: number;
  height: number;
  cells: SmCell[];
  /** 1px 连线（实心矩形，避免半像素发虚）。 */
  lines: SmRect[];
  /** 分叉点 2px 圆点。 */
  joints: SmRect[];
}

/**
 * 树形布局：叶子按深度优先依次占一格，父节点居于子节点中间；每层的 `+k` 排在最右，
 * 不连线。格宽取偶数，让方块中心落在整数像素上。
 */
export function layoutSm(levels: readonly AgentTreeLevel[]): SmLayout {
  const visible = levels.map(
    (level) => new Set(level.nodes.map((node) => node.id)),
  );
  const slotX = new Map<string, number>();
  const parentOf = new Map<string, string>();
  let slot = 0;
  const place = (node: AgentTreeNode, level: number): number => {
    const kids = node.children.filter((child) =>
      visible[level + 1]?.has(child.id),
    );
    let x: number;
    if (kids.length === 0) {
      x = slot + 0.5;
      slot += 1;
    } else {
      const xs = kids.map((kid) => {
        parentOf.set(kid.id, node.id);
        return place(kid, level + 1);
      });
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    slotX.set(node.id, x);
    return x;
  };
  const root = levels[0]!.nodes[0]!;
  place(root, 0);
  const overflowSlots: Array<{ level: number; slot: number; k: number }> = [];
  levels.forEach((level, index) => {
    if (level.overflow > 0) {
      overflowSlots.push({ level: index, slot: slot + 0.5, k: level.overflow });
      slot += 1;
    }
  });

  const slots = Math.max(1, slot);
  const cell = Math.min(
    16,
    Math.max(6, Math.floor(SM_MAX_WIDTH / slots / 2) * 2),
  );
  const px = (x: number) => Math.round(x * cell);

  const cells: SmCell[] = [];
  levels.forEach((level, index) => {
    const size = index === 0 ? SM_ROOT : SM_CHILD;
    for (const node of level.nodes) {
      cells.push({
        id: node.id,
        node,
        level: index,
        cx: px(slotX.get(node.id)!),
        top: SM_ROW_TOP[index]!,
        size,
        ...(parentOf.has(node.id) ? { parent: parentOf.get(node.id)! } : {}),
      });
    }
  });
  for (const extra of overflowSlots) {
    cells.push({
      id: `more:${extra.level}`,
      overflow: extra.k,
      level: extra.level,
      cx: px(extra.slot),
      top: SM_ROW_TOP[extra.level]!,
      size: SM_CHILD,
    });
  }

  const byId = new Map(cells.map((item) => [item.id, item]));
  const lines: SmRect[] = [];
  const joints: SmRect[] = [];
  const groups = new Map<string, SmCell[]>();
  for (const item of cells) {
    if (item.parent)
      groups.set(item.parent, [...(groups.get(item.parent) ?? []), item]);
  }
  for (const [parentId, kids] of groups) {
    const parent = byId.get(parentId)!;
    const bus = SM_BUS_Y[parent.level]!;
    const below = parent.top + parent.size;
    lines.push({ x: parent.cx, y: below, w: 1, h: bus - below + 1 });
    const xs = [parent.cx, ...kids.map((kid) => kid.cx)];
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    if (right > left)
      lines.push({ x: left, y: bus, w: right - left + 1, h: 1 });
    for (const kid of kids) {
      lines.push({ x: kid.cx, y: bus + 1, w: 1, h: kid.top - bus - 1 });
    }
    if (kids.length > 1)
      joints.push({ x: parent.cx - 1, y: bus - 0.5, w: 2, h: 2 });
  }

  const deepest = Math.max(...cells.map((item) => item.top + item.size));
  const labelRight = cells.map((item) =>
    item.overflow === undefined
      ? 0
      : item.cx - cell / 2 + String(item.overflow).length * SM_MORE_CHAR + 6,
  );
  return {
    width: Math.min(
      SM_MAX_WIDTH,
      Math.max(slots * cell, Math.ceil(Math.max(...labelRight))),
    ),
    height: Math.min(SM_MAX_HEIGHT, deepest + 2),
    cells,
    lines,
    joints,
  };
}

function NodeSquare({ item, label }: { item: SmCell; label: string }) {
  const node = item.node!;
  const color = TONE_COLOR[node.tone];
  const x = item.cx - item.size / 2;
  const y = item.top;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <g
          data-slot="agent-tree-node"
          data-tone={node.tone}
          data-kind={node.kind}
        >
          {node.tone === "idle" ? (
            <rect
              x={x + 0.5}
              y={y + 0.5}
              width={item.size - 1}
              height={item.size - 1}
              rx={1.5}
              fill="none"
              stroke="var(--faint)"
              strokeWidth={1}
            />
          ) : (
            <rect
              x={x}
              y={y}
              width={item.size}
              height={item.size}
              rx={2}
              fill={color}
            />
          )}
          {PULSING.has(node.tone) && (
            <rect
              data-slot="agent-tree-pulse"
              className={RING_CLASS}
              x={x - 1.5}
              y={y - 1.5}
              width={item.size + 3}
              height={item.size + 3}
              rx={3}
              fill="none"
              stroke={color}
              strokeWidth={1}
            />
          )}
          {node.hidden > 0 && (
            <rect
              data-slot="agent-tree-hidden"
              x={x + item.size - 1}
              y={y + item.size - 1}
              width={2}
              height={2}
              fill="var(--foreground)"
            />
          )}
          {/* 命中区：比方块大 4px，空心方块与细点也好悬停。 */}
          <rect
            x={x - 2}
            y={y - 2}
            width={item.size + 4}
            height={item.size + 4}
            fill="transparent"
          />
        </g>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AgentTreeSm({
  tree,
  className,
}: {
  tree: AgentTree;
  className?: string;
}) {
  const t = useT();
  const levels = React.useMemo(
    () => limitLevels(tree.root, AGENT_TREE_LEVEL_CAP.sm),
    [tree],
  );
  const layout = React.useMemo(() => layoutSm(levels), [levels]);
  const summary = summaryLabel(tree, t);
  // 汇总提示只在键盘聚焦时出；悬停给的是各方块自己的「名称 · 状态」。
  const [focused, setFocused] = React.useState(false);
  return (
    <Tooltip open={focused} onOpenChange={() => undefined}>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={summary}
          tabIndex={0}
          data-slot="agent-tree"
          data-size="sm"
          className={cn(
            "inline-flex shrink-0 rounded-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            className,
          )}
          onFocus={(event) => {
            try {
              setFocused(event.currentTarget.matches(":focus-visible"));
            } catch {
              setFocused(true);
            }
          }}
          onBlur={() => setFocused(false)}
        >
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden
          >
            {layout.lines.map((line, index) => (
              <rect
                key={`l${index}`}
                data-slot="agent-tree-line"
                x={line.x}
                y={line.y}
                width={line.w}
                height={line.h}
                fill="var(--border-strong)"
              />
            ))}
            {layout.joints.map((joint, index) => (
              <rect
                key={`j${index}`}
                data-slot="agent-tree-joint"
                x={joint.x}
                y={joint.y}
                width={joint.w}
                height={joint.h}
                rx={1}
                fill="var(--border-strong)"
              />
            ))}
            {layout.cells.map((item) =>
              item.node ? (
                <NodeSquare
                  key={item.id}
                  item={item}
                  label={nodeLabel(item.node, t)}
                />
              ) : (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <text
                      data-slot="agent-tree-more"
                      x={item.cx - 3}
                      y={item.top + item.size - 0.5}
                      fontSize={9}
                      fontFamily="var(--font-mono)"
                      fill="var(--muted-foreground)"
                    >
                      +{item.overflow}
                    </text>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("agentTree.more", { count: item.overflow! })}
                  </TooltipContent>
                </Tooltip>
              ),
            )}
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent>{summary}</TooltipContent>
    </Tooltip>
  );
}

/* ----------------------------------- md ----------------------------------- */

export const MD_MAX_WIDTH = 240;
const MD_ROW = 20;
const MD_SQUARE = 12;
const MD_INDENT = 16;
const MD_LABEL_CHARS = 8;

/** 极短标签：最多 8 个字，其余换成省略号（完整名称在提示里）。 */
export function shortLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length <= MD_LABEL_CHARS
    ? label
    : `${chars.slice(0, MD_LABEL_CHARS).join("")}…`;
}

interface MdRow {
  node: AgentTreeNode;
  depth: number;
  /** 祖先里（深度 1 起）哪些后面还有兄弟：决定这一行要不要续画它们的竖线。 */
  rails: boolean[];
  last: boolean;
  /** 画出来的直接下级个数；折叠时显示成 `+k` 的 k 取全部可见后代。 */
  kids: AgentTreeNode[];
  collapsed: boolean;
  descendants: number;
}

function visibleCount(
  node: AgentTreeNode,
  depth: number,
  visible: readonly Set<string>[],
): number {
  let count = 0;
  for (const child of node.children) {
    if (!visible[depth + 1]?.has(child.id)) continue;
    count += 1 + visibleCount(child, depth + 1, visible);
  }
  return count;
}

function flattenMd(
  root: AgentTreeNode,
  visible: readonly Set<string>[],
  collapsed: ReadonlySet<string>,
): MdRow[] {
  const rows: MdRow[] = [];
  const walk = (
    node: AgentTreeNode,
    depth: number,
    rails: boolean[],
    last: boolean,
  ) => {
    const kids = node.children.filter((child) =>
      visible[depth + 1]?.has(child.id),
    );
    const isCollapsed = kids.length > 0 && collapsed.has(node.id);
    rows.push({
      node,
      depth,
      rails,
      last,
      kids,
      collapsed: isCollapsed,
      descendants: visibleCount(node, depth, visible),
    });
    if (isCollapsed) return;
    kids.forEach((kid, index) =>
      walk(
        kid,
        depth + 1,
        depth === 0 ? [] : [...rails, !last],
        index === kids.length - 1,
      ),
    );
  };
  walk(root, 0, [], true);
  return rows;
}

function MdSquare({ tone }: { tone: StatusTone }) {
  const color = TONE_COLOR[tone];
  return (
    <span
      aria-hidden
      data-slot="agent-tree-square"
      data-tone={tone}
      className="relative inline-block shrink-0 rounded-tight"
      style={{
        width: MD_SQUARE,
        height: MD_SQUARE,
        ...(tone === "idle"
          ? { border: "1px solid var(--faint)" }
          : { backgroundColor: color }),
      }}
    >
      {PULSING.has(tone) && (
        <span
          data-slot="agent-tree-pulse"
          className={cn(
            "absolute -inset-[3px] rounded-control border",
            RING_CLASS,
          )}
          style={{ borderColor: color }}
        />
      )}
    </span>
  );
}

function AgentTreeMd({
  tree,
  onToggle,
  defaultCollapsed,
  className,
}: {
  tree: AgentTree;
  onToggle?: AgentTreeProps["onToggle"];
  defaultCollapsed?: AgentTreeProps["defaultCollapsed"];
  className?: string;
}) {
  const t = useT();
  const roving = useRoving<HTMLDivElement>({ orientation: "both" });
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set(defaultCollapsed),
  );
  const levels = React.useMemo(
    () => limitLevels(tree.root, AGENT_TREE_LEVEL_CAP.md),
    [tree],
  );
  const visible = React.useMemo(
    () => levels.map((level) => new Set(level.nodes.map((node) => node.id))),
    [levels],
  );
  const rows = React.useMemo(
    () => flattenMd(tree.root, visible, collapsed),
    [tree, visible, collapsed],
  );
  const summary = summaryLabel(tree, t);

  const toggle = (row: MdRow) => {
    if (row.kids.length === 0) return;
    const next = new Set(collapsed);
    const now = !next.has(row.node.id);
    if (now) next.add(row.node.id);
    else next.delete(row.node.id);
    setCollapsed(next);
    onToggle?.(row.node.id, now);
  };

  return (
    <div
      data-slot="agent-tree"
      data-size="md"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      style={{ maxWidth: MD_MAX_WIDTH }}
    >
      <div
        data-slot="agent-tree-summary"
        className="truncate font-mono text-caption text-muted-foreground"
      >
        {summary}
      </div>
      <TooltipProvider delayDuration={300}>
        <div
          role="tree"
          aria-label={summary}
          ref={roving.ref}
          onKeyDown={roving.onKeyDown}
          onFocusCapture={roving.onFocusCapture}
          className="flex flex-col"
        >
          {rows.map((row) => {
            const parent = row.kids.length > 0;
            const text = nodeLabel(row.node, t);
            return (
              <Tooltip key={row.node.id}>
                <TooltipTrigger asChild>
                  <div
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-label={text}
                    {...(parent ? { "aria-expanded": !row.collapsed } : {})}
                    data-roving-item
                    data-slot="agent-tree-row"
                    data-tone={row.node.tone}
                    data-collapsed={row.collapsed ? "true" : undefined}
                    tabIndex={-1}
                    className={cn(
                      "relative flex items-center gap-1.5 rounded-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      parent && "cursor-pointer",
                    )}
                    style={{
                      height: MD_ROW,
                      paddingLeft: row.depth * MD_INDENT,
                    }}
                    onClick={() => toggle(row)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggle(row);
                      }
                    }}
                  >
                    {row.depth > 0 && (
                      <MdRails
                        rails={row.rails}
                        depth={row.depth}
                        last={row.last}
                      />
                    )}
                    <MdSquare tone={row.node.tone} />
                    <span className="min-w-0 truncate font-mono text-caption text-foreground">
                      {shortLabel(row.node.label)}
                    </span>
                    {row.collapsed && (
                      <span
                        data-slot="agent-tree-folded"
                        className="shrink-0 font-mono text-caption text-muted-foreground"
                      >
                        · +{row.descendants}
                      </span>
                    )}
                    {!row.collapsed && row.node.hidden > 0 && (
                      <span className="shrink-0 font-mono text-caption text-muted-foreground">
                        +{row.node.hidden}
                      </span>
                    )}
                    {parent &&
                      (row.collapsed ? (
                        <ChevronRight
                          aria-hidden
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <ChevronDown
                          aria-hidden
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      ))}
                  </div>
                </TooltipTrigger>
                <TooltipContent>{text}</TooltipContent>
              </Tooltip>
            );
          })}
          {levels.map((level, index) =>
            level.overflow > 0 ? (
              <div
                key={`more:${index}`}
                data-slot="agent-tree-more"
                className="flex items-center font-mono text-caption text-muted-foreground"
                style={{ height: MD_ROW, paddingLeft: index * MD_INDENT }}
              >
                +{level.overflow}
              </div>
            ) : null,
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}

/** 一行左边的连线：祖先的续线 + 自己连到父节点的肘线，都是 1px。 */
function MdRails({
  rails,
  depth,
  last,
}: {
  rails: boolean[];
  depth: number;
  last: boolean;
}) {
  const center = MD_ROW / 2;
  const x = (column: number) => column * MD_INDENT + MD_SQUARE / 2;
  const line = "absolute bg-border-strong";
  return (
    <>
      {rails.map((continues, index) =>
        continues ? (
          <span
            key={index}
            aria-hidden
            data-slot="agent-tree-rail"
            className={line}
            style={{ left: x(index), top: 0, width: 1, height: MD_ROW }}
          />
        ) : null,
      )}
      <span
        aria-hidden
        data-slot="agent-tree-elbow"
        className={line}
        style={{
          left: x(depth - 1),
          top: 0,
          width: 1,
          height: last ? center + 1 : MD_ROW,
        }}
      />
      <span
        aria-hidden
        data-slot="agent-tree-elbow"
        className={line}
        style={{
          left: x(depth - 1),
          top: center,
          width: MD_INDENT - MD_SQUARE / 2 - 1,
          height: 1,
        }}
      />
    </>
  );
}

/* ---------------------------------- 入口 ---------------------------------- */

export function AgentTree({
  tree,
  size,
  onToggle,
  defaultCollapsed,
  className,
}: AgentTreeProps) {
  return size === "sm" ? (
    <TooltipProvider delayDuration={300}>
      <AgentTreeSm tree={tree} {...(className ? { className } : {})} />
    </TooltipProvider>
  ) : (
    <AgentTreeMd
      tree={tree}
      {...(onToggle ? { onToggle } : {})}
      {...(defaultCollapsed ? { defaultCollapsed } : {})}
      {...(className ? { className } : {})}
    />
  );
}
