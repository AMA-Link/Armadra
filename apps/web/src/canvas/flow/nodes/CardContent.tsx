import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

import {
  NODE_BODY,
  NODE_SHELL_SELF,
  type NodeBodyProps,
} from "@/nodes/registry";
import { NodeShell } from "@/nodes/NodeShell";
import { NodeBodyFallback } from "@/nodes/NodeBodyFallback";

/**
 * 节点内容：壳 + 懒加载的节点体；一种宿主组件（`board/CardHost`）装下七种
 * 节点体，`data` 就是 `CanvasNode`。
 */
export function CardContent({
  node,
  selected,
  focused,
}: {
  node: CanvasNode;
  selected: boolean;
  focused: boolean;
}) {
  const bodyProps: NodeBodyProps = {
    id: node.id,
    node,
    selected,
    collapsed: node.collapsed === true,
    focused,
  };
  const Body = NODE_BODY[node.type];
  return (
    <>
      {/* 头部插槽住在节点体里的类型（终端、编辑器、变更、文件、浏览器、
          两张自动化卡）自己渲染 `NodeShell`；其余（便签）走通用包壳。 */}
      {/* 节点体按种类懒加载（`nodes/registry.ts`）。边界在 `NodeShell`
          **里面**：壳、头部、边框是这一层画的，不该跟着节点体一起等。
          分块 200 ms 内到位就不画占位，更久才出节点体骨架（§5.16）。 */}
      {NODE_SHELL_SELF.has(node.type) ? (
        // 这几类的壳画在节点体里面，`fallback={null}` 会让整个节点（连头部）
        // 在分块加载完之前都看不见，只剩一个空的选中框；先画一个空壳顶上。
        <React.Suspense
          fallback={
            <NodeShell node={node} selected={selected}>
              <NodeBodyFallback type={node.type} />
            </NodeShell>
          }
        >
          <Body {...bodyProps} />
        </React.Suspense>
      ) : (
        <NodeShell node={node} selected={selected}>
          <React.Suspense fallback={<NodeBodyFallback type={node.type} />}>
            <Body {...bodyProps} />
          </React.Suspense>
        </NodeShell>
      )}
    </>
  );
}
