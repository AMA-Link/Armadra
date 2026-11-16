import { describe, expect, it } from "vitest";

import { createDraw } from "./draw";
import { makeBoard, pointer } from "./testing";
import type { GestureDeps } from "./types";

const at = (x: number, y: number) => pointer({ x, y });

describe("draw", () => {
  it("start / extend / finish 回调，结束发 create；finish 返回 null 丢弃", () => {
    const { board, of } = makeBoard();
    const feedback: unknown[] = [];
    const deps: GestureDeps = { feedback: (f) => void feedback.push(f) };
    const hooks = {
      start: (p: ReturnType<typeof at>) => [p.world.x],
      extend: (d: number[], p: ReturnType<typeof at>) => [...d, p.world.x],
      finish: (d: number[]) => (d.length > 2 ? d : null),
    };
    const g = createDraw({ board, deps }, at(1, 0), "ink", hooks);
    g.move(at(2, 0));
    g.move(at(3, 0));
    g.end(at(3, 0));
    expect(of("create")).toEqual([{ tool: "ink", draft: [1, 2, 3] }]);
    expect(feedback.at(-1)).toBeNull();
    createDraw({ board, deps }, at(1, 0), "ink", hooks).end(at(1, 0));
    expect(of("create")).toHaveLength(1);
  });
});
