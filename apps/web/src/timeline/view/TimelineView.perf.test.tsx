import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { TimelineItem } from "@armadra/shared";

vi.mock("@/store/canvas-store", () => {
  const state = { workspace: { rootPath: "/repo" } };
  const useCanvasStore = <T,>(selector: (s: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});
vi.mock("@/files/open-editor", () => ({ openFileInEditor: vi.fn() }));

import { TimelineView } from "./TimelineView";
import { mockLayout, settleAtBottom } from "./test-layout";
import {
  assistantItem,
  longSession,
  resetFixtureCounter,
  userItem,
} from "./fixtures";

beforeEach(mockLayout);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 组件级基准（设计 §4 的「每个分块主线程开销与会话长度无关」）：300 条助手消息的
 * 会话里，一个流式分块进来，整棵树提交一次要花多久。阈值留足 CI 的余量；真实
 * 数字在 PR 描述里，对照旧的整表重渲染。
 */
describe("streaming cost", () => {
  // 基准本身是固有的长活：短、长各渲染三遍（长的一遍有 300 轮），单跑约 0.6 秒，
  // 机器忙时放大到 5 秒以上。给 30 秒；通过的用例不会因此变慢。
  it(
    "per-chunk commit time does not grow with the session length",
    { timeout: 30_000 },
    () => {
      const measure = (turns: number): number => {
        cleanup();
        resetFixtureCounter();
        const base = longSession(turns);
        const rect = { width: 600, height: 600 };
        let text = "";
        const frame = (n: number): TimelineItem[] => {
          text += "chunk with some words in it, ";
          const streaming = assistantItem(turns + 1, text, 0, true);
          return [
            ...base,
            userItem(turns + 1, "go"),
            { ...streaming, rev: 100_000 + n } as TimelineItem,
          ];
        };
        const { rerender } = render(
          <TimelineView items={frame(0)} initialRect={rect} />,
        );
        settleAtBottom();
        expect(document.body.textContent).toContain("chunk with");
        const samples: number[] = [];
        for (let n = 1; n <= 40; n++) {
          const items = frame(n);
          const start = performance.now();
          act(() =>
            rerender(<TimelineView items={items} initialRect={rect} />),
          );
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)] as number;
      };
      // 同一次运行里自己做基线，且短、长交替测三轮、各取最小值：机器忙起来是把两边
      // 一起拖慢（比值不变），偶发的一次尖峰只会抬高某一轮，取最小值就把它滤掉。
      // 因此不设绝对毫秒上限，只比「长会话是不是比短会话慢出一个数量级」。
      const shorts: number[] = [];
      const longs: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        shorts.push(measure(20));
        longs.push(measure(300));
      }
      const short = Math.min(...shorts);
      const long = Math.min(...longs);
      process.stderr.write(
        `stream chunk commit median (best of 3): 20 turns ${short.toFixed(2)} ms, 300 turns ${long.toFixed(2)} ms\n`,
      );
      expect(long).toBeLessThan(Math.max(short * 6, 12));
    },
  );
});
