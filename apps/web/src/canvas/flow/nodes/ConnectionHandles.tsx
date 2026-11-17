import { useT } from "@/app/preferences-store";
import { useCanvasReadOnly } from "@/store/canvas/presence";
import { useIsBoardHost } from "../../board/host-context";

/**
 * 节点的连线端口：起笔把手。四边中点各一个，引擎按 `data-board-handle` 认它们
 * （`dom/input/target.ts`），拖出来发 `connect` 事件（`board/use-board-connect.tsx`）。
 * 只有把手能起笔，节点体不能——否则在终端里划一下选文字就会拉出一条线。尺寸与
 * 命中区沿用平台设计 §4.1，样式在 `styles/nodes.css`。
 *
 * 落点不需要把手：引擎按指针下的实体判落点，整块节点体都算。分组与白板对象只作
 * 落点，什么都不画；只读时不画（引擎也不会起手势）。
 */

/** 四边中点各一个起笔把手（ui-wave2 §3.3）。四个把手不分进出：线怎么走由两端的相对位置与边的角色决定，不读把手坐标。 */
const SIDES = ["top", "right", "bottom", "left"] as const;

export interface ConnectionHandlesProps {
  /** 只作落点、不画起笔把手（分组与白板对象）。 */
  dropOnly?: boolean;
}

/**
 * 不在画板宿主里（手机焦点页直接渲染节点体）就不画把手。
 */
export function ConnectionHandles({ dropOnly }: ConnectionHandlesProps = {}) {
  const t = useT();
  const readOnly = useCanvasReadOnly();
  const inBoard = useIsBoardHost();
  if (!inBoard || dropOnly || readOnly) return null;
  return SIDES.map((side) => (
    <span
      key={side}
      aria-label={t("node.linkHandle")}
      className="board-connection-handle"
      data-board-handle={side}
      data-slot="connection-handle"
      data-side={side}
    />
  ));
}
