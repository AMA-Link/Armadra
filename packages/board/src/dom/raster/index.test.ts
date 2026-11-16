import { describe, expect, it } from "vitest";

import { createMemoryScene, type Entity } from "../../core";
import type { DomKindSpec } from "../types";
import {
  MAX_RASTER_EDGE,
  planRaster,
  rasterize,
  RasterError,
  type RasterEnv,
} from "./index";

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "shape",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  z: 0,
  data: null,
  ...patch,
});

function setup() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get:
      (_t, key: string) =>
      (...args: unknown[]) =>
        calls.push(`${key}(${args.join(",")})`),
    set: (_t, key: string, value) => (
      calls.push(`${key}=${String(value)}`),
      true
    ),
  });
  let size = [0, 0];
  const env: RasterEnv = {
    createSurface: (w, h) => {
      size = [w, h];
      return { width: w, height: h, getContext: () => ctx as never };
    },
    toBlob: async () => new Blob(["png"], { type: "image/png" }),
  };
  const painted: string[] = [];
  const spec: DomKindSpec = {
    layer: "canvas-under",
    paint: (_c, e, p) =>
      painted.push(`${e.id}@${e.x},${e.y} z${p.zoom} ${p.theme}`),
  };
  const kinds = (k: string) => (k === "shape" ? spec : undefined);
  const scene = createMemoryScene();
  return { calls, env, painted, kinds, scene, size: () => size };
}

describe("planRaster", () => {
  it("包围盒加留白乘密度；超大时降密度而不是裁剪", () => {
    const plan = planRaster(
      { x: 10, y: 20, w: 100, h: 50 },
      { padding: 10, scale: 2 },
    );
    expect(plan).toMatchObject({
      x: 0,
      y: 10,
      w: 120,
      h: 70,
      pixelWidth: 240,
      pixelHeight: 140,
    });
    const big = planRaster({ x: 0, y: 0, w: 10000, h: 100 }, { padding: 0 });
    expect(big.pixelWidth).toBe(MAX_RASTER_EDGE);
    expect(big.scale).toBeLessThan(1);
  });
});

describe("rasterize", () => {
  it("按 z 序用同一套 paint 画选中的实体，坐标平移到包围盒左上角，底色先铺", async () => {
    const { calls, env, painted, kinds, scene, size } = setup();
    scene.transact((d) => {
      d.set(make("b", { z: 2, x: 100, y: 100 }));
      d.set(make("a", { z: 1, x: 50, y: 40 }));
      d.set(make("skip", { x: 900 }));
    });
    const blob = await rasterize(
      scene,
      kinds,
      ["b", "a"],
      { padding: 0, scale: 1, background: "#fff" },
      env,
    );
    expect(blob.type).toBe("image/png");
    expect(painted).toEqual(["a@50,40 z1 light", "b@100,100 z1 light"]);
    expect(size()).toEqual([150, 110]);
    expect(calls.indexOf("fillStyle=#fff")).toBeLessThan(
      calls.indexOf("setTransform(1,0,0,1,-50,-40)"),
    );
  });

  it("没有可画的实体就拒绝；子实体用绝对坐标", async () => {
    const { env, painted, kinds, scene } = setup();
    await expect(
      rasterize(scene, kinds, ["x"], {}, env),
    ).rejects.toBeInstanceOf(RasterError);
    scene.transact((d) => {
      d.set(make("g", { x: 10, y: 10 }));
      d.set(make("c", { parent: "g", x: 5, y: 5 }));
    });
    await rasterize(scene, kinds, ["c"], {}, env);
    expect(painted).toEqual(["c@15,15 z1 light"]);
  });

  it("prepare 先于绘制", async () => {
    const { env, painted, kinds, scene } = setup();
    scene.transact((d) => d.set(make("a")));
    const order: string[] = [];
    await rasterize(
      scene,
      kinds,
      ["a"],
      {},
      {
        ...env,
        prepare: async () => void order.push(`prepare(${painted.length})`),
      },
    );
    expect(order).toEqual(["prepare(0)"]);
    expect(painted.length).toBe(1);
  });
});
