import { describe, expect, it } from "vitest";

import { createPan } from "./pan";
import { makeBoard, pointer } from "./testing";

describe("pan / pinch", () => {
  it("平移按屏幕增量移动相机，锁定后不动", () => {
    const { board, camera } = makeBoard();
    const g = createPan({ board, deps: {} }, pointer({ x: 10, y: 10 }));
    g.move(pointer({ x: 30, y: 25 }));
    expect(camera.get()).toMatchObject({ x: 20, y: 15 });
    camera.locked = true;
    g.move(pointer({ x: 100, y: 100 }));
    expect(camera.get()).toMatchObject({ x: 20, y: 15 });
  });

  it("第二根手指切到 pinch：间距翻倍则缩放翻倍，中点下的世界点不动", () => {
    const { board, camera } = makeBoard();
    const ctx = { board, deps: {} };
    const pan = createPan(ctx, pointer({ x: 100, y: 100 }));
    const pinch = pan.add!(pointer({ x: 200, y: 100 }, { id: 2 }))!;
    expect(pinch.name).toBe("pinch");
    const before = camera.screenToWorld({ x: 150, y: 100 });
    pinch.move(pointer({ x: 50, y: 100 }, { id: 1 }));
    pinch.move(pointer({ x: 250, y: 100 }, { id: 2 }));
    expect(camera.get().zoom).toBeCloseTo(2);
    expect(camera.worldToScreen(before).x).toBeCloseTo(150);
  });
});
