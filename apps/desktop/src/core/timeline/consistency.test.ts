import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type TimelineState,
  applyTimelineFrame,
  applyTimelineSync,
  emptyTimelineState,
  sortedTimelineItems,
  timelineStateFrom,
} from "@armadra/shared";

import { type AcpCore, FAKE_AGENT, acpCore, until } from "../acp/fixture";
import type { WorkspaceEvent } from "../bus";
import { openDatabase } from "../db/open";
import { migrationsDir } from "../workspaces/fixture";
import { TimelineDomain, install } from ".";

/**
 * 时间线一致性（B10，设计 §8）：同一条 ACP 会话的时间线，两个订阅者各自按
 * 「帧顺序应用、缺口即 sync」维护本地状态；一个中途掉线、一个收到重复与乱序的帧；
 * core 重启（重开数据库、新的域对象）后再比一遍。断言：条目、`rev` 与 `head_seq`
 * 两端等同，帧首尾相接，序号不重不丢。
 */

let open: AcpCore | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface Frame {
  from: number;
  to: number;
  ops: never;
}

/** 一个订阅者：本地状态 + 对应「帧顺序应用、缺口即 sync」。 */
class Subscriber {
  state: TimelineState = emptyTimelineState();
  online = true;
  gaps = 0;
  duplicates = 0;
  constructor(
    private readonly domain: () => TimelineDomain,
    readonly id: string,
  ) {}

  /** 打开：整份快照（全部回合）。 */
  openSnapshot(): void {
    const snapshot = this.domain().store.snapshot(this.id, 1000)!;
    this.state = timelineStateFrom(snapshot);
  }

  receive(frame: Frame): void {
    if (!this.online) return;
    const result = applyTimelineFrame(this.state, frame);
    if (result.outcome === "duplicate") this.duplicates += 1;
    if (result.outcome === "gap") {
      this.gaps += 1;
      this.sync();
      return;
    }
    this.state = result.state;
  }

  /** 重连：从本地序号补。 */
  sync(domain: TimelineDomain = this.domain()): void {
    const result = domain.store.sync(this.id, this.state.seq)!;
    this.state = applyTimelineSync(this.state, result);
  }
}

/** 条目的 id 与 rev，按显示顺序（键序无关）。 */
function fingerprint(items: readonly { id: string; rev: number }[]): string {
  return JSON.stringify(items.map(({ id, rev }) => [id, rev]));
}

describe("时间线一致性", () => {
  it("两个订阅者（一个掉线重连、一个收重复与乱序帧）与库一致，core 重启后仍一致", async () => {
    open = await acpCore();
    const domain = install(open.core) as TimelineDomain;
    const live = () => domain;
    const frames: Frame[] = [];
    const seen: WorkspaceEvent[] = [];
    const subs: { a?: Subscriber; b?: Subscriber } = {};
    // B 在线时：帧先攒着，回合结束后倒序投递（乱序：先到的是后面的帧，触发缺口 sync）。
    let batch: Frame[] | undefined;
    open.core.bus.on("workspace.event", ({ event }) => {
      seen.push(event);
      if (event.type !== "timeline.delta") return;
      const frame = event as unknown as Frame & { timelineId: string };
      frames.push(frame);
      // A：每帧投两遍（重复）。
      subs.a?.receive(frame);
      subs.a?.receive(frame);
      if (batch === undefined) subs.b?.receive(frame);
      else batch.push(frame);
    });

    const nodeId = await open.node();
    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
      prompt: "one [think] [plan]",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = (created.body as { id: string }).id;
    const turns = () => seen.filter((event) => event.type === "acp.turn");
    const a = (subs.a = new Subscriber(live, id));
    const b = (subs.b = new Subscriber(live, id));
    a.openSnapshot();
    b.openSnapshot();
    await until(turns, (all) => all.length >= 1);

    // 第二个回合：B 掉线（丢掉这段时间的所有帧）。
    b.online = false;
    await open.core.call("POST", `/api/acp/sessions/${id}/prompt`, {
      text: "two [think]",
    });
    await until(turns, (all) => all.length >= 2);
    domain.writer.flush();
    b.online = true;
    expect(b.state.seq).toBeLessThan(domain.store.get(id)!.headSeq);
    b.sync();

    // 第三个回合：两个订阅者都在线，B 的帧倒序到达。
    batch = [];
    await open.core.call("POST", `/api/acp/sessions/${id}/prompt`, {
      text: "three [plan]",
    });
    await until(turns, (all) => all.length >= 3);
    domain.writer.flush();
    expect(batch.length).toBeGreaterThan(1);
    for (const frame of [...batch].reverse()) b.receive(frame);
    batch = undefined;

    const truth = domain.store.snapshot(id, 1000)!;
    const head = domain.store.get(id)!.headSeq;
    expect(truth.items.length).toBeGreaterThan(6);
    for (const who of [a, b]) {
      expect(who.state.seq).toBe(head);
      expect(fingerprint(sortedTimelineItems(who.state))).toBe(
        fingerprint(truth.items),
      );
      expect(sortedTimelineItems(who.state)).toEqual(truth.items);
    }
    expect(a.duplicates).toBeGreaterThan(0);
    expect(b.gaps).toBeGreaterThan(0);

    // 帧首尾相接：不丢、不重、不乱序。
    let cursor = 0;
    for (const frame of frames) {
      expect(frame.from).toBe(cursor);
      expect(frame.to).toBeGreaterThan(frame.from);
      cursor = frame.to;
    }
    expect(cursor).toBe(head);

    // core 重启：把库落盘、拷到另一处、用真正的打开流程重开，新的域对象。
    domain.writer.flush();
    open.core.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    scratch = mkdtempSync(join(tmpdir(), "armadra-tl-restart-"));
    const file = join(scratch, "canvas.db");
    copyFileSync(join(open.core.directory, "canvas.db"), file);
    const reopened = openDatabase({ file, migrationsDir: migrationsDir() });
    const revived = new TimelineDomain({ ...open.core, db: reopened });
    try {
      revived.recoverInterrupted();
      const after = revived.store.snapshot(id, 1000)!;
      expect(after.headSeq).toBe(head);
      expect(after.items).toEqual(truth.items);
      expect(revived.store.get(id)!.headSeq).toBe(head);

      // 重启前的订阅者原地接上：序号相同，补不出任何东西。
      const sameAsBefore = revived.store.sync(id, a.state.seq)!;
      expect(sameAsBefore.items).toEqual([]);
      // 落后一截的缓存（只有前一个回合）补齐后与重启后的库一致。
      const stale = new Subscriber(() => revived, id);
      const firstTurnOnly = truth.items.filter((item) => item.turn <= 1);
      stale.state = timelineStateFrom({
        headSeq: Math.max(...firstTurnOnly.map((item) => item.rev)),
        items: firstTurnOnly,
      });
      stale.sync(revived);
      expect(stale.state.seq).toBe(head);
      expect(sortedTimelineItems(stale.state)).toEqual(after.items);

      // 重启后接着写：序号从库里的 head 续上，不回头也不跳。
      revived.open({
        timelineId: id,
        workspaceId: open.workspaceId,
        nodeId,
      });
      const lastTurn = Math.max(...truth.items.map((item) => item.turn));
      revived.writer.turnBegin(
        id,
        {
          turnId: "t-after-restart",
          turn: lastTurn + 1,
          at: Date.now(),
          gen: 1,
        },
        { text: "after restart" },
      );
      revived.writer.flush();
      const grown = revived.store.get(id)!.headSeq;
      expect(grown).toBeGreaterThan(head);
      const delta = revived.store.sync(id, head)!;
      expect(delta.headSeq).toBe(grown);
      expect(Math.min(...delta.items.map((item) => item.rev))).toBe(head + 1);
    } finally {
      revived.close();
      reopened.close();
    }
  }, 60_000);
});
