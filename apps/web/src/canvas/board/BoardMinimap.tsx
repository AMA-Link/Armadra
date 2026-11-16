import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import type { Entity } from "@armadra/board/core";
import {
  createMinimap,
  type DomBoard,
  type Minimap as EngineMinimap,
} from "@armadra/board/dom";

import { useMinimapPreferences } from "@/app/minimap-preferences";
import { useResolvedTheme, useT } from "@/app/preferences-store";
import { linkColor } from "../flow/edges/link-visual";
import {
  minimapFill,
  minimapItemOf,
  minimapStroke,
  minimapStrokeWidth,
  minimapToggleStyle,
  MinimapToggleButton,
  useGlowOf,
} from "../flow/Minimap";
import { useFamilies } from "../family";
import { edgeDataOf, isEdgeEntity } from "./edge-model";
import { GHOST_KIND } from "./model";

/**
 * 状态缩略图（自研引擎，B4）：用引擎的 `createMinimap`，配色与旧引擎同一套纯函数
 * （`minimapFill` / `minimapStroke` / 簇色、状态描边）。
 *
 * 引擎的缩略图是一张 Canvas，画不了 CSS 变量与 `color-mix()`，所以每个颜色字符串
 * 先交给浏览器算成 `rgb()`（`resolveColor`，探针元素继承主题变量）。连线是引擎里带
 * `ends` 的实体，缩略图把它们画成两端矩形中心的连线，颜色与画布上同一规则
 * （上下文线 `--link-context`、派发线取主的簇色）。
 */

/** 浏览器把任意 CSS 颜色（含 `var()`、`color-mix()`）算成 Canvas 认得的字符串。 */
export type ColorResolver = ((css: string) => string) & { dispose(): void };

export function createColorResolver(host: HTMLElement): ColorResolver {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none";
  host.append(probe);
  const cache = new Map<string, string>();
  const resolve: ColorResolver = Object.assign(
    (css: string): string => {
      const hit = cache.get(css);
      if (hit !== undefined) return hit;
      probe.style.color = "";
      probe.style.color = css;
      const value = getComputedStyle(probe).color || css;
      cache.set(css, value);
      return value;
    },
    { dispose: () => probe.remove() },
  );
  return resolve;
}

/** 与 `BoardView` 是兄弟（要贴在舞台右下角），所以板由属性传入，不读 context。 */
export function BoardMinimap({ board }: { board: DomBoard<CanvasNode> }) {
  const { collapsed, setCollapsed } = useMinimapPreferences();
  return (
    <>
      {collapsed ? null : <MinimapView board={board} />}
      <div
        className="minimap-toggle-panel"
        style={minimapToggleStyle(collapsed)}
      >
        <MinimapToggleButton
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
        />
      </div>
    </>
  );
}

function MinimapView({ board }: { board: DomBoard<CanvasNode> }) {
  const t = useT();
  const theme = useResolvedTheme();
  const glowOf = useGlowOf();
  const families = useFamilies();
  const element = React.useRef<HTMLDivElement>(null);
  const minimap = React.useRef<EngineMinimap | null>(null);
  // 颜色函数每次渲染换新，缩略图读最新的那份（状态与簇色变了只需 `invalidate`）。
  const latest = React.useRef({ glowOf, families });
  latest.current = { glowOf, families };

  React.useEffect(() => {
    const host = element.current;
    if (!host) return;
    const resolve = createColorResolver(host);
    const link = (entity: Entity) => {
      const data = edgeDataOf(entity);
      const supervises = data.role === "supervises";
      const source = entity.ends?.[0] ?? "";
      const color = linkColor({
        supervises,
        familyColor: latest.current.families.get(source)?.color,
      });
      return {
        fill: "transparent",
        stroke: resolve(color),
        strokeWidth: 1.5,
      };
    };
    const created = createMinimap(host, {
      scene: board.scene,
      camera: board.camera,
      colors: {
        mask: resolve("var(--hover)"),
        frame: resolve("var(--border-strong)"),
      },
      colorOf: (entity) => {
        if (isEdgeEntity(entity)) {
          // 引用不是 Agent 之间的关系，缩略图里不画。
          return edgeDataOf(entity).type === "link" ? link(entity) : null;
        }
        // 切走的板上留着的网页节点是零面积的点，不画。
        if (entity.kind === GHOST_KIND) return null;
        const item = minimapItemOf(
          {
            id: entity.id,
            type: entity.kind === "group" ? "group" : "armadra",
            selected: board.selection().has(entity.id),
          },
          latest.current.glowOf,
          latest.current.families,
        );
        const stroke = minimapStroke(item);
        return {
          fill: resolve(minimapFill(item)),
          stroke: resolve(stroke),
          strokeWidth: minimapStrokeWidth(stroke) / 2,
        };
      },
    });
    minimap.current = created;
    const offSelection = board.on("selection", () => created.invalidate());
    return () => {
      offSelection();
      created.destroy();
      resolve.dispose();
      minimap.current = null;
    };
    // 主题变了令牌的取值就变：重建，重新解析颜色。
  }, [board, theme]);

  React.useEffect(() => {
    minimap.current?.invalidate();
  }, [glowOf, families]);

  return (
    <div
      ref={element}
      className="board-minimap"
      data-testid="minimap.canvas"
      role="img"
      aria-label={t("canvas.minimap")}
    />
  );
}
