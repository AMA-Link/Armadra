import { describe, expect, it } from "vitest";

import { createConnect } from "./connect";
import { box, makeBoard, pointer } from "./testing";

const at = (x: number, y: number) => pointer({ x, y });
const run = (
  g: {
    move(p: ReturnType<typeof at>): void;
    end(p: ReturnType<typeof at>): void;
  } | null,
  to: [number, number],
) => {
  g!.move(at(...to));
  g!.end(at(...to));
};

describe("connect", () => {
  const world = () =>
    makeBoard([box("a", 0, 0), box("b", 300, 0), box("x", 600, 0)]);

  it("落在别的实体上发 connect(to)，反馈里带 over", () => {
    const { board, of } = world();
    const feedback: unknown[] = [];
    const g = createConnect(
      { board, deps: { feedback: (f) => feedback.push(f) } },
      at(100, 50),
      "a",
      "right",
    );
    g!.move(at(350, 50));
    expect(feedback[0]).toMatchObject({
      type: "connect",
      from: "a",
      side: "right",
      over: "b",
    });
    g!.end(at(350, 50));
    expect(of("connect")).toEqual([
      { from: "a", side: "right", to: "b", at: { x: 350, y: 50 } },
    ]);
  });

  it("落在空白发 to: null；落在自己身上不算；没拖动不发", () => {
    const { board, of } = world();
    run(
      createConnect({ board, deps: {} }, at(100, 50), "a", "right"),
      [200, 400],
    );
    run(
      createConnect({ board, deps: {} }, at(100, 50), "a", "right"),
      [50, 50],
    );
    createConnect({ board, deps: {} }, at(100, 50), "a", "right")!.end(
      at(101, 50),
    );
    expect(of("connect").map((e) => (e as { to: unknown }).to)).toEqual([
      null,
      null,
    ]);
  });

  it("KindSpec.connect 的 start / end 约束", () => {
    const { board, of } = world();
    const kind = (k: string) => ({
      layer: "world" as const,
      connect: { start: k !== "none", end: false },
    });
    run(
      createConnect({ board, deps: { kind } }, at(100, 50), "a", "right"),
      [350, 50],
    );
    expect((of("connect")[0] as { to: unknown }).to).toBeNull();
    const noStart = {
      kind: () => ({
        layer: "world" as const,
        connect: { start: false, end: true },
      }),
    };
    expect(
      createConnect({ board, deps: noStart }, at(0, 0), "a", "top"),
    ).toBeNull();
  });
});
