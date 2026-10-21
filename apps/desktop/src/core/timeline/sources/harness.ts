/**
 * 转录来源用例的共用件（只给测试用）：内存库里的时间线域、夹具读取、条目摘要。
 */

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type TimelineItem, sortedTimelineItems } from "@armadra/shared";

import type { WorkspaceEvent } from "../../bus";
import { hookFixture, type HookFixture } from "../../hook/fixture";
import { type TimelineDomain, install as installTimeline } from "..";
import { FakeTimers } from "../testing";
import type { SourceManagerOptions } from "./index";
import { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureLines(name: string): string[] {
  return readFileSync(join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

export interface Rig {
  readonly fixture: HookFixture;
  readonly domain: TimelineDomain;
  readonly database: DatabaseSync;
  /** `timeline.delta` / `timeline.activity` 等帧，按发出顺序。 */
  readonly events: WorkspaceEvent[];
  close(): void;
}

/** 真库（全部迁移）里的时间线域，带一个终端节点；来源的计时器等可注入。 */
export function rig(
  sources?: Partial<Omit<SourceManagerOptions, "database">>,
): Rig {
  let domain: TimelineDomain | undefined;
  const fixture = hookFixture([
    (context) => {
      domain = installTimeline(context, {
        bootId: "boot",
        ...(sources !== undefined ? { sources } : {}),
      });
    },
  ]);
  const events = fixture.published;
  return {
    fixture,
    domain: domain as TimelineDomain,
    database: fixture.core.database,
    events,
    close: () => {
      domain?.close();
      fixture.close();
    },
  };
}

/** 把一个适配器作用在一批行上，答最终库里的全部条目（按显示顺序）。 */
export function convertAll(
  adapter: TranscriptAdapter,
  lines: readonly string[],
  options: { timelineId?: string } = {},
): { items: TimelineItem[]; head: Record<string, unknown> } {
  const r = rig();
  try {
    const timelineId = options.timelineId ?? "tl-1";
    r.domain.open({
      timelineId,
      workspaceId: r.fixture.workspaceId,
      nodeId: r.fixture.nodeId,
      source: "transcript",
    });
    const sink = new TimelineSink(r.domain.writer, timelineId);
    for (const line of lines) adapter.convert(JSON.parse(line), sink);
    r.domain.writer.flush(timelineId);
    const state = r.domain.store.loadState(timelineId, 100);
    return {
      items: sortedTimelineItems(state),
      head: state.head as Record<string, unknown>,
    };
  } finally {
    r.close();
  }
}

export { FakeTimers };
