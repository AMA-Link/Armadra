import type { GraphCommit, GraphKeys } from "../CommitGraph";

/**
 * 逐行布线的提交图布局（#942）。
 *
 * 一条边不再是「子 → 父」一条曲线，而是在它经过的**每一行**都有一个车道：
 *
 * - `active` 是在两行之间往下走的边。处理一行时，节点落在第一条等它的边上；
 *   其余也在等它的边在上一行斜着汇进节点（多条车道可以等同一个父提交）。
 * - 第一父接着用节点所在的位置，其余父插在节点右边。
 * - 每行之后删掉空位：右边的线左移一格，图始终紧凑，不会越往下越像台阶。
 * - 跨度超过 `longEdge` 行的边不占列：子提交处一个 ↓，父提交前 `STUB_ROWS`
 *   行再以 ↑ 出现；父提交不在本页时画虚线残桩，不猜位置。
 * - 颜色在边出生时定（新分支尖端、合并的其余父），沿第一父链往下继承。
 *
 * 坐标约定：第 r 行上，经过的边位于它在 `active`（处理 r 之前）里的下标；
 * 第 r 行与第 r+1 行之间的一段从 r 行的位置连到 r+1 行的位置。
 */

/** 每一行的节点。 */
export interface LayoutRow {
  key: string;
  lane: number;
  /** 颜色链：同一条分支（第一父链）同一个号。 */
  chain: number;
  /** 这一行实际占用的车道数，标题按它缩进。 */
  width: number;
}

/** 第 `row` 行与 `row + 1` 行之间的一段。 */
export interface LayoutSegment {
  row: number;
  from: number;
  to: number;
  chain: number;
  child: string;
  parent: string;
}

/** 长边的两端：`down` 在子提交下方，`up` 在父提交上方几行。 */
export interface LayoutArrow {
  row: number;
  lane: number;
  dir: "down" | "up";
  chain: number;
  child: string;
  parent: string;
}

/** 父提交不在本页：节点下方一小段虚线。 */
export interface LayoutStub {
  row: number;
  lane: number;
  chain: number;
  child: string;
  parent: string;
}

export interface GraphLayout {
  rows: LayoutRow[];
  byKey: Map<string, LayoutRow & { row: number }>;
  segments: LayoutSegment[];
  arrows: LayoutArrow[];
  stubs: LayoutStub[];
  /** 全页最宽的一行。 */
  lanes: number;
}

/** 跨度超过这么多行的边截成两段箭头。 */
export const LONG_EDGE_ROWS = 24;
/** ↑ 出现在父提交上方几行：紧挨着父提交，和别的汇入线一起斜进去。 */
const STUB_ROWS = 1;

interface Entry {
  parent: string;
  chain: number;
  child: string;
  /** 刚以 ↑ 重新出现：它上面一段不画。 */
  resumed: boolean;
}

export function graphLayout<T extends GraphCommit>(
  commits: readonly T[],
  keys: GraphKeys<T>,
  longEdge: number = LONG_EDGE_ROWS,
): GraphLayout {
  const rowOf = new Map<string, number>();
  for (const [row, commit] of commits.entries()) {
    rowOf.set(keys.key(commit), row);
  }

  let chains = 0;
  let active: Entry[] = [];
  /** 每一行处理完之后往下走的边（行 r 与 r+1 之间）。 */
  const between: Entry[][] = [];
  /** 每一行处理之前从上面下来的边（行 r 上的位置 = 下标）。 */
  const above: Entry[][] = [];
  const rows: LayoutRow[] = [];
  const arrows: LayoutArrow[] = [];
  const stubs: LayoutStub[] = [];
  /** 长边：在第几行之后重新放进 `active`。 */
  const resume = new Map<number, Entry[]>();

  for (const [row, commit] of commits.entries()) {
    const self = keys.key(commit);
    above.push(active);
    const waiting = active.findIndex((entry) => entry.parent === self);
    const lane = waiting < 0 ? active.length : waiting;
    const chain = waiting < 0 ? chains++ : active[waiting]!.chain;

    // 节点那一格换成第一父；其余等它的边在这一行结束（汇入）。
    const next: (Entry | null)[] = active.map((entry) =>
      entry.parent === self ? null : entry,
    );
    if (waiting < 0) next.push(null);
    const born: Entry[] = [];
    for (const [index, parentOid] of commit.parents.entries()) {
      const parent = keys.parent(commit, parentOid);
      const entry: Entry = {
        parent,
        chain: index === 0 ? chain : chains++,
        child: self,
        resumed: false,
      };
      const at = rowOf.get(parent);
      if (at === undefined || at <= row) {
        stubs.push({ row, lane, chain: entry.chain, child: self, parent });
        continue;
      }
      const back = at - STUB_ROWS - 1;
      if (at - row > longEdge && back > row) {
        arrows.push({
          row,
          lane,
          dir: "down",
          chain: entry.chain,
          child: self,
          parent,
        });
        resume.set(back, [
          ...(resume.get(back) ?? []),
          { ...entry, resumed: true },
        ]);
        continue;
      }
      born.push(entry);
    }
    // 第一父占节点的位置，其余父紧挨着插在右边。
    const [first, ...rest] = born;
    const isFirst = first !== undefined && first.chain === chain;
    next[lane] = isFirst ? first : null;
    next.splice(lane + 1, 0, ...(isFirst ? rest : born));
    for (const entry of resume.get(row) ?? []) next.push(entry);
    resume.delete(row);

    active = next.filter((entry): entry is Entry => entry !== null);
    between.push(active);
    rows.push({
      key: self,
      lane,
      chain,
      // 汇进本节点的线到了这一行已经收拢在节点上，不占宽度。
      width: Math.max(
        lane + 1,
        active.length,
        ...above[row]!.map((entry, index) =>
          entry.parent === self ? 0 : index + 1,
        ),
      ),
    });
  }

  // 第二遍：两行之间的段。终点是下一行上的位置；那一行就是父提交时，终点是
  // 父提交节点的车道（汇入）。
  const segments: LayoutSegment[] = [];
  for (const [row, entries] of between.entries()) {
    const nextRow = rows[row + 1];
    const passing = above[row]!;
    const node = rows[row]!;
    for (const [index, entry] of entries.entries()) {
      if (entry.resumed && !passing.includes(entry)) {
        // 刚以 ↑ 回来：箭头画在下一行它的位置上，这一段不画。
        arrows.push({
          row: row + 1,
          lane: index,
          dir: "up",
          chain: entry.chain,
          child: entry.child,
          parent: entry.parent,
        });
        continue;
      }
      const from = passing.indexOf(entry);
      const to = nextRow && nextRow.key === entry.parent ? nextRow.lane : index;
      segments.push({
        row,
        from: from < 0 ? node.lane : from,
        to,
        chain: entry.chain,
        child: entry.child,
        parent: entry.parent,
      });
    }
  }

  const byKey = new Map(
    rows.map((entry, row) => [entry.key, { ...entry, row }] as const),
  );
  return {
    rows,
    byKey,
    segments,
    arrows,
    stubs,
    lanes: Math.max(1, ...rows.map((entry) => entry.width)),
  };
}
