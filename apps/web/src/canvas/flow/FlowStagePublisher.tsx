import * as React from "react";
import { useStore } from "@xyflow/react";

import { publishStageView } from "./stage-view";

/**
 * 旧引擎的视口 → `stage-view`。挂在 `<ReactFlow>` 里，订阅它的变换与尺寸；
 * 卸载时清回缺省（B6 删旧引擎时整个文件一并删）。
 */
export function FlowStagePublisher(): null {
  const x = useStore((state) => state.transform[0]);
  const y = useStore((state) => state.transform[1]);
  const zoom = useStore((state) => state.transform[2]);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  React.useEffect(() => {
    publishStageView({ x, y, zoom, width, height });
  }, [x, y, zoom, width, height]);
  React.useEffect(() => () => publishStageView(null), []);
  return null;
}
