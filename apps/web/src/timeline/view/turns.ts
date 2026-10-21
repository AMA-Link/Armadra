import type { TimelineItem } from "@armadra/shared";

export interface TurnBlock {
  readonly turn: number;
  readonly items: readonly TimelineItem[];
}

function sameItems(
  a: readonly TimelineItem[],
  b: readonly TimelineItem[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as TimelineItem;
    const y = b[i] as TimelineItem;
    if (x !== y && (x.id !== y.id || x.rev !== y.rev)) return false;
  }
  return true;
}

/**
 * 按回合分段。`items` 已按显示顺序给（回合、序号）。传入上一次的结果，内容
 * 没变（id 与 `rev` 都相同）的回合沿用旧对象，下游按引用 memo 就不会重渲染。
 */
export function groupTurns(
  items: readonly TimelineItem[],
  previous: readonly TurnBlock[] = [],
): TurnBlock[] {
  const old = new Map<number, TurnBlock>();
  for (const block of previous) old.set(block.turn, block);
  const blocks: TurnBlock[] = [];
  let turn: number | null = null;
  let run: TimelineItem[] = [];
  const flush = (): void => {
    if (turn === null) return;
    const before = old.get(turn);
    blocks.push(
      before !== undefined && sameItems(before.items, run)
        ? before
        : { turn, items: run },
    );
  };
  for (const item of items) {
    if (item.turn !== turn) {
      flush();
      turn = item.turn;
      run = [];
    }
    run.push(item);
  }
  flush();
  return blocks;
}
