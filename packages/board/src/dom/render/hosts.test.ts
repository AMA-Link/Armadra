// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createMemoryScene, type Entity } from "../../core";
import { createWorldHosts } from "./hosts";

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "card",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  z: 0,
  data: null,
  ...patch,
});

const kinds = {
  card: { layer: "world" as const },
  group: { layer: "world" as const },
  ink: { layer: "canvas-under" as const },
};
const setup = () => {
  const scene = createMemoryScene({
    kinds: (kind) => kinds[kind as keyof typeof kinds],
  });
  const world = document.createElement("div");
  const hosts = createWorldHosts({
    world,
    scene,
    kind: (kind) => kinds[kind as keyof typeof kinds],
  });
  return { scene, world, hosts };
};

describe("createWorldHosts", () => {
  it("只给 world 层实体建宿主，带 data-board-id，位置尺寸取整", () => {
    const { scene, hosts, world } = setup();
    scene.transact((d) => {
      d.set(make("a", { x: 10.4, y: 20.6, w: 100.5, h: 49.5 }));
      d.set(make("i", { kind: "ink" }));
    });
    const host = hosts.hostOf("a")!;
    expect(host.dataset.boardId).toBe("a");
    expect(host.parentElement).toBe(world);
    expect(host.style.transform).toBe("translate(10px, 21px)");
    expect(host.style.width).toBe("101px");
    expect(host.style.height).toBe("50px");
    expect(hosts.hostOf("i")).toBeUndefined();
  });

  it("子实体按相对父换算成世界坐标，父移动时子宿主随之更新", () => {
    const { scene, hosts } = setup();
    scene.transact((d) => {
      d.set(make("g", { kind: "group", x: 100, y: 100, w: 400, h: 400 }));
      d.set(make("c", { parent: "g", x: 10, y: 20 }));
    });
    const child = hosts.hostOf("c")!;
    expect(child.style.transform).toBe("translate(110px, 120px)");
    scene.transact((d) => d.update("g", { x: 200 }));
    expect(child.style.transform).toBe("translate(210px, 120px)");
  });

  it("预览中的几何直接写进宿主，清掉预览后回到文档值", () => {
    const { scene, hosts } = setup();
    scene.transact((d) => d.set(make("a")));
    scene.preview(new Map([["a", { x: 50 }]]));
    expect(hosts.hostOf("a")!.style.transform).toBe("translate(50px, 0px)");
    scene.clearPreview();
    expect(hosts.hostOf("a")!.style.transform).toBe("translate(0px, 0px)");
  });

  it("只追加不重排：改 z 或在中间插入，已有宿主的 DOM 顺序与引用不变，层级靠 z-index", () => {
    const { scene, hosts, world } = setup();
    scene.transact((d) => {
      d.set(make("a", { z: 1 }));
      d.set(make("b", { z: 2 }));
    });
    const [a, b] = [hosts.hostOf("a")!, hosts.hostOf("b")!];
    scene.transact((d) => {
      d.update("a", { z: 5 });
      d.set(make("c", { z: 0 }));
    });
    expect(
      [...world.children].map((el) => (el as HTMLElement).dataset.boardId),
    ).toEqual(["a", "b", "c"]);
    expect(hosts.hostOf("a")).toBe(a);
    expect(hosts.hostOf("b")).toBe(b);
    const z = (id: string) => Number(hosts.hostOf(id)!.style.zIndex);
    expect(z("c")).toBeLessThan(z("b"));
    expect(z("b")).toBeLessThan(z("a"));
  });

  it("实体消失才移除宿主并通知；kind 改成别的层也算移除", () => {
    const { scene, hosts, world } = setup();
    const listener = vi.fn();
    scene.transact((d) => {
      d.set(make("a"));
      d.set(make("b"));
    });
    hosts.subscribe(listener);
    scene.transact((d) => d.remove("a"));
    expect(hosts.hostOf("a")).toBeUndefined();
    expect(world.children.length).toBe(1);
    expect(listener).toHaveBeenLastCalledWith({ added: [], removed: ["a"] });
    scene.transact((d) => d.update("b", { kind: "ink" }));
    expect(hosts.hostOf("b")).toBeUndefined();
  });

  it("挂载时已有的实体立即建宿主；destroy 清空", () => {
    const scene = createMemoryScene();
    scene.transact((d) => d.set(make("a")));
    const world = document.createElement("div");
    const hosts = createWorldHosts({ world, scene, kind: () => undefined });
    expect(hosts.hostOf("a")).toBeDefined();
    hosts.destroy();
    expect(world.children.length).toBe(0);
  });
});
