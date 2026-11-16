import * as React from "react";
import type { Node, NodeProps } from "@xyflow/react";

import { inkPath } from "../ink";
import {
  colorHex,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_SCALE,
  strokeWidth,
} from "../palette";
import { useCanvasScheme } from "../scheme";
import type { InkItem } from "../model";
import { ItemFrame } from "./ItemFrame";

/**
 * 墨迹与高亮（React Flow 计划 F22，归属 whiteboard）。
 *
 * 点集是相对对象原点的；缩放对象时点集不动（v3 记原始盒 `origin`），由 viewBox 与
 * `preserveAspectRatio="none"` 缩放。
 *
 * 轮廓由 `perfect-freehand` 生成后当**填充路径**画（不是描边），所以线宽
 * 随压力变化。高亮笔粗四倍、半透明、`multiply` 混合：压在文字上仍然读得
 * 出下面的字。
 */

export type InkFlowNode = Node<InkItem, "wb.ink">;

export function InkNode({ data, selected = false }: NodeProps<InkFlowNode>) {
  const scheme = useCanvasScheme();
  const base = strokeWidth(data.style.size);
  const size = data.highlight ? base * HIGHLIGHT_SCALE : base;
  const d = React.useMemo(
    () => inkPath(data.points, { size, highlight: data.highlight }),
    [data.highlight, data.points, size],
  );

  return (
    <ItemFrame item={data} selected={selected}>
      <svg
        width="100%"
        height="100%"
        // 点集在落成时的原始盒里（v3 缩放不重写点集）：viewBox 取原始盒，缩放由
        // `preserveAspectRatio="none"` 完成。
        viewBox={`0 0 ${Math.max(data.origin?.w ?? data.w, 1)} ${Math.max(data.origin?.h ?? data.h, 1)}`}
        preserveAspectRatio="none"
        style={{
          display: "block",
          overflow: "visible",
          opacity: data.highlight ? HIGHLIGHT_OPACITY : 1,
          mixBlendMode: data.highlight ? "multiply" : undefined,
        }}
        aria-hidden
      >
        <path d={d} fill={colorHex(data.style.color, scheme)} />
      </svg>
    </ItemFrame>
  );
}

export default React.memo(InkNode);
