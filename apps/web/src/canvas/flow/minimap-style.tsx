import * as React from "react";
import { Map, Minus } from "lucide-react";

import type { AgentGlow } from "@/agent/display";
import { useAgentStatusStore } from "@/agent/status-store";
import {
  headerStateFor,
  useProgramStatusStore,
} from "@/agent/program-status-store";
import { useT } from "@/app/preferences-store";
import { scoped } from "@/sources/scope";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { isItemId } from "../whiteboard/model";
import type { Family } from "../family";

/**
 * 状态缩略图的配色与收起钮（`board/BoardMinimap` 用）。
 *
 * 配色（ui-wave2 §5.2）：填充按 `familyOf`——派发簇同色、独立 Agent 标识色、
 * 其他节点按类型；描边是三种状态，派发簇成员无状态时描边用簇色。全是按对象
 * 求值的纯函数。收起状态在 `app/minimap-preferences.ts`，位置右下角、离右边与
 * 下边各 14px，画布再窄也不挪（是 Dock 向左让，`styles/canvas.css`）。
 */

/* -------------------------------- 颜色 ------------------------------------ */

/** 状态 → 描边色用的 CSS 变量（`styles/tokens.css`）。 */
export const MINIMAP_COLORS = {
  /** working：陶土色。 */
  working: "var(--agent-working)",
  /** needs-you。 */
  attention: "var(--status-attention)",
  /** 最近一个回合出错、还没人看过：和胶囊、圆点同一个红（S3）。 */
  failed: "var(--status-failed)",
  /** 未读。 */
  unread: "var(--brand)",
  /** 无状态的节点、白板对象与分组：一块低对比的底（弱前景色 `--faint`）。 */
  plain: "var(--faint)",
} as const;

export interface MinimapItem {
  /** 白板对象（`wb:` 前缀）与分组一律低对比，不参与状态描边。 */
  plain?: boolean;
  glow?: AgentGlow;
  selected?: boolean;
  /** `familyOf` 给的颜色（簇色 / 标识色 / 类型色）；白板对象没有。 */
  color?: string;
  /** 派发簇成员：无状态时描边也用簇色。 */
  cluster?: boolean;
}

/**
 * 状态 → 描边色（旧画布契约 §3.2）。
 *
 * 状态的优先级由 `sessionDisplay()` 定好了（一个节点同一时刻只会有
 * 一种光晕，和节点头是同一个结果），这里只做映射；没有状态的节点用中性描边。
 */
export function minimapStroke(item: MinimapItem): string {
  if (item.plain) return MINIMAP_COLORS.plain;
  switch (item.glow) {
    case "working":
      return MINIMAP_COLORS.working;
    case "attention":
      return MINIMAP_COLORS.attention;
    case "failed":
      return MINIMAP_COLORS.failed;
    case "unread":
      return MINIMAP_COLORS.unread;
    default:
      // 派发簇的描边用簇色：同一个主派出来的一眼连成一片。对等线不改色。
      return item.cluster && item.color ? item.color : MINIMAP_COLORS.plain;
  }
}

/** 状态描边色的集合，`minimapStrokeWidth` 靠它认出「有状态」。 */
const STATUS_STROKES: ReadonlySet<string> = new Set([
  MINIMAP_COLORS.working,
  MINIMAP_COLORS.attention,
  MINIMAP_COLORS.failed,
  MINIMAP_COLORS.unread,
]);

/**
 * 有状态的节点画粗一点：缩略图上 1px 的色差不够，粗细才看得见。
 *
 * 入参是**描边色**而不是节点：画的那一层只知道算好的颜色。
 */
export function minimapStrokeWidth(stroke: string): number {
  return STATUS_STROKES.has(stroke) ? 4 : 2;
}

/**
 * 矩形填充：节点按 `familyOf` 的颜色混透明，浓度取主题令牌——常态 `--mm-fill`、
 * 选中 `--mm-fill-selected`、分组与白板对象 `--mm-fill-plain`（深色 55% / 80% /
 * 35%，浅色更淡，`styles/tokens.css`）。白板对象没有家族色，退回弱前景色 `--faint`。
 */
export function minimapFill(item: MinimapItem): string {
  const color = item.color ?? "var(--faint)";
  const strength = item.plain
    ? "var(--mm-fill-plain)"
    : item.selected
      ? "var(--mm-fill-selected)"
      : "var(--mm-fill)";
  return `color-mix(in srgb, ${color} ${strength}, transparent)`;
}

/** 缩略图里的一个对象：上色要看的位。 */
export interface MinimapSubject {
  id: string;
  /** `armadra` 是节点；`group`（分组）与白板对象（`wb:` 前缀的 id）都画成低对比。 */
  type: string;
  selected?: boolean;
}

/** 对象 → 上色要看的那几个位（分组和白板对象都算 `plain`）。 */
export function minimapItemOf(
  node: MinimapSubject,
  glowOf: (nodeId: string) => AgentGlow | undefined,
  families?: ReadonlyMap<string, Family>,
): MinimapItem {
  const item = isItemId(node.id);
  const plain = node.type !== "armadra" || item;
  const glow = plain ? undefined : glowOf(node.id);
  const family = item ? undefined : families?.get(node.id);
  return {
    plain,
    selected: node.selected === true,
    ...(glow ? { glow } : {}),
    ...(family ? { color: family.color } : {}),
    ...(family?.kind === "cluster" && !plain ? { cluster: true } : {}),
  };
}

/* -------------------------------- 组件 ------------------------------------ */

/** 收起钮所在容器的位置：展开时贴缩略图右上角，收起后原地当展开入口。 */
export function minimapToggleStyle(collapsed: boolean): React.CSSProperties {
  return collapsed
    ? {
        margin: 0,
        right: "calc(14px + var(--surface-inset-right, 0px))",
        bottom: "var(--navigation-bottom)",
      }
    : {
        margin: 0,
        right: "calc(18px + var(--surface-inset-right, 0px))",
        bottom: "calc(var(--navigation-bottom) + var(--minimap-h) - 28px)",
      };
}

/** 收起 / 展开钮本体；容器由画布给。 */
export function MinimapToggleButton({
  collapsed,
  onToggle,
  reveal = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  reveal?: boolean;
}) {
  const t = useT();
  const label = t(
    collapsed ? "canvas.expandMinimap" : "canvas.collapseMinimap",
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          size={collapsed ? "cluster" : "inline"}
          data-slot="minimap-toggle"
          data-reveal={reveal ? "true" : undefined}
          className={
            collapsed
              ? "minimap-toggle border border-border-strong bg-panel/90 backdrop-blur-[12px]"
              : "minimap-toggle bg-panel/90 hover:bg-hover hover:text-foreground"
          }
          label={label}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <Map /> : <Minus />}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 节点 id → 它的状态光晕。状态每变一次都要重刷描边色，所以订阅整张表；程序自报
 * （契约 §53）与上报按节点头同一条规则合并，描边色才和节点头一致。
 */
export function useGlowOf(): (nodeId: string) => AgentGlow | undefined {
  const statuses = useAgentStatusStore((state) => state.statuses);
  const programs = useProgramStatusStore((state) => state.programs);
  const seen = useProgramStatusStore((state) => state.seen);
  return React.useCallback(
    (nodeId: string) => {
      const key = scoped(nodeId);
      const status = statuses[key];
      return headerStateFor(
        Boolean(status?.agentId),
        status,
        programs[key],
        Boolean(seen[key]),
      ).glow;
    },
    [statuses, programs, seen],
  );
}
