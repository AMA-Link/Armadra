import * as React from "react";
import { useStore, useStoreApi } from "@xyflow/react";

import { useT } from "@/app/preferences-store";
import { useLayoutDirection } from "@/canvas/layout-direction";
import { labelFontSize, LABEL_MIN_ZOOM, type LabelBox } from "./edge-label";
import { routerFor, type EdgeLayout } from "./edge-router";

/**
 * 两条边组件共用的钩子与一枚标签（#318）。
 */

/**
 * 这条边的布局（路线、分道后的折线、标签）。全画布一个路由器
 * （`edge-router.ts`），这条边的结果没变时拿到的是同一个对象，不重渲。
 */
export function useEdgeLayout(id: string): EdgeLayout | null {
  const store = useStoreApi();
  const router = routerFor(store);
  const t = useT();
  const direction = useLayoutDirection();
  const fontSize = useLabelFont();
  const read = React.useCallback(
    () => router.read(id, { direction, fontSize, t }),
    [router, id, direction, fontSize, t],
  );
  return React.useSyncExternalStore(router.subscribe, read, read);
}

/**
 * 标签字号只订阅到整数（`labelFontSize`）：缩放手势每一帧都在变，但标签
 * 只在字号真的变了时才重新摆。低于 {@link LABEL_MIN_ZOOM} 时为 0（不画）。
 */
export function useLabelFont(): number {
  return useStore((state) => {
    const zoom = state.transform[2];
    return zoom < LABEL_MIN_ZOOM ? 0 : labelFontSize(zoom);
  });
}

/**
 * 线上的关系标签：一枚纸色底、线色描边的小胶囊。
 *
 * 文字用线自己的颜色而不是 `--foreground`：画布纸张色是用户单独选的
 * （`--canvas-bg`），深色主题下也可能是一张浅色纸。底色就是纸色，所以线
 * 从胶囊下面穿过去时不会划过字。不接收指针：点它等于点画布。
 */
export function EdgeLabel({ box, text }: { box: LabelBox; text: string }) {
  return (
    <g data-slot="edge-label" pointerEvents="none">
      <rect
        x={box.x - box.width / 2}
        y={box.y - box.height / 2}
        width={box.width}
        height={box.height}
        rx={box.height / 2}
        fill="var(--canvas-bg)"
        stroke="currentColor"
        strokeOpacity={0.4}
        strokeWidth={box.fontSize / 11}
      />
      <text
        x={box.x}
        y={box.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={box.fontSize}
        fill="currentColor"
        style={{ userSelect: "none", fontWeight: 500 }}
      >
        {text}
      </text>
    </g>
  );
}
