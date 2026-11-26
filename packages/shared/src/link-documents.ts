/**
 * 链接文档的编译判据（Armadra#1062 S1）：画布上的节点与连线 → 每个终端节点
 * 「它能读谁、能投给谁」的那份文档。
 *
 * core 在每次写板（`canvas/documents.ts::writeDocument`）的同一事务里用它重算，
 * 页面不再推节点链接；白板对象的内容链接（`kind: "shape"`）带着页面才画得出的
 * PNG，仍由页面推送，core 用 {@link mergeLinkDocument} 把两半并成一份。
 *
 * 只有终端节点有文档：`POST /context-link/*` 与 `canvas` 动词只有终端会调；
 * 文档里的对端是任意类型，`kind` 就是对端的节点类型。
 */

/** 一份链接文档最多几条（core 的校验与页面的截断同一个数）。 */
export const MAX_CONTEXT_LINKS = 64;

/** 白板内容链接的 `kind`；节点链接的 `kind` 是节点类型。 */
export const CONTENT_LINK_KIND = "shape";

/** 链接标题的上限（core 的校验同一个数）；节点标题更长时截断，不让整份文档被拒。 */
export const MAX_LINK_TITLE = 160;

export type LinkRole = "peer" | "main" | "sub";

export interface LinkGraphNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
}

export interface LinkGraphEdge {
  readonly source: string;
  readonly target: string;
  readonly role?: string | null;
}

export interface NodeLink {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly role: LinkRole;
}

/** 合并与比较只用到的那几个字段；core 与页面各自的 `ContextLink` 都满足。 */
export interface LinkLike {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly role?: string;
  readonly content?: { readonly sourceShapeId?: string } | null;
}

function clampTitle(title: string): string {
  return Array.from(title).slice(0, MAX_LINK_TITLE).join("");
}

/**
 * 每个终端节点 → 它经连线连到的节点（无向，两头都算）。
 *
 * 角色是对端相对本节点的位置：`supervises` 边的 source 一侧看见 `sub`，target
 * 一侧看见 `main`；其余是 `peer`。同一对节点有多条边时取第一条（按传入顺序）。
 * 指向不存在节点的边跳过。
 */
export function buildNodeLinks(
  nodes: readonly LinkGraphNode[],
  edges: readonly LinkGraphEdge[],
): Record<string, NodeLink[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const documents: Record<string, NodeLink[]> = {};
  for (const node of nodes) {
    if (node.type === "terminal") documents[node.id] = [];
  }
  for (const edge of edges) {
    const supervises = edge.role === "supervises";
    const ends: readonly (readonly [string, string, LinkRole])[] = [
      [edge.source, edge.target, supervises ? "sub" : "peer"],
      [edge.target, edge.source, supervises ? "main" : "peer"],
    ];
    for (const [owner, other, role] of ends) {
      const links = documents[owner];
      const peer = byId.get(other);
      if (links === undefined || peer === undefined || owner === other)
        continue;
      if (links.some((link) => link.id === peer.id)) continue;
      links.push({
        id: peer.id,
        title: clampTitle(peer.title),
        kind: peer.type,
        role,
      });
    }
  }
  return documents;
}

/**
 * 一个节点的完整文档：节点链接在前，内容链接在后，截到
 * {@link MAX_CONTEXT_LINKS}。与节点链接同 id，或与已收的内容链接同
 * `sourceShapeId` 的内容链接跳过。
 */
export function mergeLinkDocument<T extends LinkLike>(
  nodeLinks: readonly T[],
  contentLinks: readonly T[],
): T[] {
  const merged: T[] = [...nodeLinks];
  for (const link of contentLinks) {
    const shapeId = link.content?.sourceShapeId;
    const duplicate = merged.some(
      (existing) =>
        existing.id === link.id ||
        (shapeId !== undefined &&
          existing.kind === CONTENT_LINK_KIND &&
          existing.content?.sourceShapeId === shapeId),
    );
    if (!duplicate) merged.push(link);
  }
  return merged.slice(0, MAX_CONTEXT_LINKS);
}

/** 内容链接那一半（页面推送的部分）。 */
export function contentLinksOf<T extends LinkLike>(links: readonly T[]): T[] {
  return links.filter((link) => link.kind === CONTENT_LINK_KIND);
}

/** 两份文档是否一致；顺序也算，存的是数组。 */
export function sameLinkDocument(
  a: readonly LinkLike[] | undefined,
  b: readonly LinkLike[],
): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((link, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      link.id === other.id &&
      link.title === other.title &&
      link.kind === other.kind &&
      (link.role ?? undefined) === (other.role ?? undefined) &&
      JSON.stringify(link.content ?? null) ===
        JSON.stringify(other.content ?? null)
    );
  });
}
