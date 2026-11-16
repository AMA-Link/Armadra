import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_MODS } from "../gestures/testing";
import type { PointerInput } from "../types";
import { createTouchRecognizer } from "./recognizers";

const touch = (
  x: number,
  y: number,
  time: number,
  id = 1,
  extra: Partial<PointerInput> = {},
): PointerInput => ({
  id,
  type: "touch",
  button: 0,
  screen: { x, y },
  world: { x, y },
  pressure: 0.5,
  mods: NO_MODS,
  target: { type: "blank" },
  time,
  ...extra,
});

describe("触屏识别器", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const setup = (longPress = true) => {
    const long: PointerInput[] = [];
    const doubles: PointerInput[] = [];
    const r = createTouchRecognizer({
      longPress: (p) => (long.push(p), longPress),
      doubleTap: (p) => void doubles.push(p),
    });
    return { r, long, doubles };
  };

  it("按住不动 500ms 触发长按，并记下触发时间", () => {
    const { r, long } = setup();
    r.down(touch(10, 10, 1000));
    vi.advanceTimersByTime(499);
    expect(long).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(long).toHaveLength(1);
    expect(r.firedAt).toBe(1500);
  });

  it("手指移动超过容差、第二根手指、鼠标、输入区都不触发长按", () => {
    const { r, long } = setup();
    r.down(touch(10, 10, 0));
    r.move(touch(30, 10, 100));
    vi.advanceTimersByTime(600);
    r.down(touch(10, 10, 0));
    r.down(touch(50, 50, 0, 2));
    vi.advanceTimersByTime(600);
    r.down(touch(10, 10, 0, 1, { type: "mouse" }));
    r.down(touch(10, 10, 0, 1, { target: { type: "editable" } }));
    vi.advanceTimersByTime(600);
    expect(long).toHaveLength(0);
  });

  it("两下短按、间隔与距离都在范围内 = 双击，落点是第二下", () => {
    const { r, doubles } = setup();
    r.down(touch(10, 10, 0));
    r.up(touch(10, 10, 100));
    r.down(touch(20, 12, 250));
    r.up(touch(20, 12, 330));
    expect(doubles).toHaveLength(1);
    expect(doubles[0]!.screen).toEqual({ x: 20, y: 12 });
  });

  it("太慢、太远、按太久都不算双击", () => {
    const { r, doubles } = setup();
    r.down(touch(10, 10, 0));
    r.up(touch(10, 10, 100));
    r.down(touch(10, 10, 600));
    r.up(touch(10, 10, 700));
    r.down(touch(200, 10, 800));
    r.up(touch(200, 10, 900));
    r.down(touch(200, 10, 1000));
    r.up(touch(200, 10, 1400));
    expect(doubles).toHaveLength(0);
  });
});
