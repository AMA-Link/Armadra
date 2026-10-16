import type { CanvasNode } from "@armadra/shared";

export interface NodeTreeRow {
  node: CanvasNode;
  depth: number;
}

/** Preserve canvas order while placing each node below its real group. */
export function nodeTreeRows(nodes: readonly CanvasNode[]): NodeTreeRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const key =
      parent?.type === "group" && parent.boardId === node.boardId
        ? parent.id
        : "";
    const siblings = children.get(key) ?? [];
    siblings.push(node);
    children.set(key, siblings);
  }

  const rows: NodeTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (node: CanvasNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ node, depth });
    for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
  };
  for (const node of children.get("") ?? []) visit(node, 0);
  // Malformed legacy cycles have no root. Still show each node once.
  for (const node of nodes) visit(node, 0);
  return rows;
}
