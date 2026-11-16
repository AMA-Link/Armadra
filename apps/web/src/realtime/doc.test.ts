import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { WHITEBOARD_COLORS, WHITEBOARD_SIZES } from "../app/preferences-store";
import { emptyWhiteboard, type Item } from "../canvas/whiteboard/model";
import {
  itemsOf,
  metaOf,
  nodesOf,
  readRemote,
  rebaseText,
  writeLocal,
  type LocalSnapshot,
} from "./doc";
import { BOARD, NOTE, ONE, TWO, sticky, terminal } from "./realtime.fixture";

const ORIGIN = { test: true };

function snapshot(
  nodes: LocalSnapshot["nodes"],
  whiteboard = emptyWhiteboard(),
): LocalSnapshot {
  return { nodes, edges: [], whiteboard };
}

const EMPTY = snapshot([]);

function ink(id: string, z: number): Item {
  return {
    id,
    kind: "ink",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    z,
    points: [
      [0, 0, 0.5],
      [1, 1, 0.5],
    ],
    style: { color: WHITEBOARD_COLORS[0], size: WHITEBOARD_SIZES[0] },
  } as Item;
}

describe("文档结构（契约 §16.1）", () => {
  it("新节点整个写进去，正文进 Y.Text，读回来逐字段相同", () => {
    const doc = new Y.Doc();
    const note = sticky(NOTE, "hello");
    const local = snapshot([terminal(ONE, 0), note]);
    expect(writeLocal(doc, EMPTY, local, ORIGIN)).toBe(true);
    const map = nodesOf(doc).get(NOTE)!;
    expect(map.get("content")).toBeInstanceOf(Y.Text);
    expect(map.get("data")).toEqual({ kind: "sticky" });
    expect(map.has("id")).toBe(false);

    const remote = readRemote(doc, BOARD.id, EMPTY);
    expect(remote.nodes).toEqual(local.nodes);
  });

  it("只写身份变了的那几条：沿用的对象一个字段都不碰", () => {
    const doc = new Y.Doc();
    const one = terminal(ONE, 0);
    const two = terminal(TWO, 400);
    writeLocal(doc, EMPTY, snapshot([one, two]), ORIGIN);
    const writes: string[] = [];
    nodesOf(doc).observeDeep((events) => {
      for (const event of events) writes.push(String(event.path[0] ?? "root"));
    });
    const moved = { ...one, position: { x: 50, y: 0 } };
    writeLocal(doc, snapshot([one, two]), snapshot([moved, two]), ORIGIN);
    expect(writes).toEqual([ONE]);
    expect(nodesOf(doc).get(ONE)!.get("position")).toEqual({ x: 50, y: 0 });
  });

  it("读回时内容没变的实体沿用本地对象，整表没变就返回同一个数组", () => {
    const doc = new Y.Doc();
    const local = snapshot([terminal(ONE, 0), terminal(TWO, 1)]);
    writeLocal(doc, EMPTY, local, ORIGIN);
    const remote = readRemote(doc, BOARD.id, local);
    expect(remote.nodes).toBe(local.nodes);
    expect(remote.whiteboard).toBe(local.whiteboard);
  });

  it("别人删了的节点，本地改它不会复活", () => {
    const doc = new Y.Doc();
    const one = terminal(ONE, 0);
    writeLocal(doc, EMPTY, snapshot([one]), ORIGIN);
    nodesOf(doc).delete(ONE);
    writeLocal(
      doc,
      snapshot([one]),
      snapshot([{ ...one, title: "late" }]),
      ORIGIN,
    );
    expect(nodesOf(doc).has(ONE)).toBe(false);
  });

  it("校验不过的节点不进 store", () => {
    const doc = new Y.Doc();
    writeLocal(doc, EMPTY, snapshot([terminal(ONE, 0)]), ORIGIN);
    nodesOf(doc).get(ONE)!.set("position", { x: "nope" });
    expect(readRemote(doc, BOARD.id, EMPTY).nodes).toEqual([]);
  });

  it("便签正文按改动的那一段写，并发输入两边的字都留下", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const base = sticky(NOTE, "hello");
    writeLocal(a, EMPTY, snapshot([base]), ORIGIN);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    writeLocal(
      a,
      snapshot([base]),
      snapshot([{ ...base, data: { kind: "sticky", content: "hello world" } }]),
      ORIGIN,
    );
    writeLocal(
      b,
      snapshot([base]),
      snapshot([{ ...base, data: { kind: "sticky", content: "say hello" } }]),
      ORIGIN,
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const doc of [a, b]) {
      expect(String(nodesOf(doc).get(NOTE)!.get("content"))).toBe(
        "say hello world",
      );
    }
  });

  it("白板按 item 一条 JSON 串，读回逐项校验", () => {
    const doc = new Y.Doc();
    const whiteboard = {
      ...emptyWhiteboard(),
      items: [ink("a", 1), ink("b", 0)],
    };
    writeLocal(doc, EMPTY, snapshot([], whiteboard), ORIGIN);
    expect([...itemsOf(doc).keys()].sort()).toEqual(["a", "b"]);
    itemsOf(doc).set("c", "{not json");
    const remote = readRemote(doc, BOARD.id, EMPTY);
    expect(remote.whiteboard.items.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("白板对象的 v3 线上格式", () => {
  const withInk = () => {
    const doc = new Y.Doc();
    const whiteboard = { ...emptyWhiteboard(), items: [ink("a", 1)] };
    writeLocal(doc, EMPTY, snapshot([], whiteboard), ORIGIN);
    return { doc, whiteboard };
  };

  it("每项存的是 encodeItem 的串（短键、点集压成串），读回逐项解码", () => {
    const { doc, whiteboard } = withInk();
    const wire = JSON.parse(itemsOf(doc).get("a")!) as Record<string, unknown>;
    expect(wire).toMatchObject({ id: "a", k: "ink", b: [0, 0, 1, 1], z: 1 });
    expect(typeof wire.pt).toBe("string");
    const remote = readRemote(doc, BOARD.id, EMPTY);
    expect(remote.whiteboard.items).toEqual(whiteboard.items);
  });

  it("本地对象的线上串与文档里逐字相同时沿用本地对象（身份不变）", () => {
    const { doc, whiteboard } = withInk();
    const local = snapshot([], whiteboard);
    expect(readRemote(doc, BOARD.id, local).whiteboard).toBe(local.whiteboard);
  });

  it("上一代 v2 的整条 JSON、损坏的串读回时忽略，传了 origin 就在事务里删掉", () => {
    const { doc } = withInk();
    itemsOf(doc).set(
      "old",
      JSON.stringify({ id: "old", kind: "ink", points: [[0, 0, 0.5]] }),
    );
    itemsOf(doc).set("junk", "{not json");
    const seen: unknown[] = [];
    doc.on("afterTransaction", (t: Y.Transaction) => seen.push(t.origin));
    const quiet = readRemote(doc, BOARD.id, EMPTY);
    expect(quiet.whiteboard.items.map((i) => i.id)).toEqual(["a"]);
    expect([...itemsOf(doc).keys()].sort()).toEqual(["a", "junk", "old"]);
    const pruned = readRemote(doc, BOARD.id, EMPTY, ORIGIN);
    expect(pruned.whiteboard.items.map((i) => i.id)).toEqual(["a"]);
    expect([...itemsOf(doc).keys()]).toEqual(["a"]);
    expect(seen).toContain(ORIGIN);
  });

  it("文档里是上一代外壳时，写入白板内容会把外壳换成 v3 的", () => {
    const { doc } = withInk();
    metaOf(doc).set(
      "whiteboardEnvelope",
      JSON.stringify({ engine: "armadra-flow", version: 2 }),
    );
    const before = { ...emptyWhiteboard(), items: [ink("a", 1)] };
    const after = { ...emptyWhiteboard(), items: [ink("a", 1), ink("b", 2)] };
    writeLocal(doc, snapshot([], before), snapshot([], after), ORIGIN);
    expect(JSON.parse(metaOf(doc).get("whiteboardEnvelope") as string)).toEqual(
      { engine: "armadra-board", version: 3 },
    );
  });
});

describe("rebaseText：编辑期间别人改了正文", () => {
  it("两段不重叠时两边的字都留下", () => {
    expect(rebaseText("hello", "hello world", "say hello")).toBe(
      "say hello world",
    );
    expect(rebaseText("hello", "say hello", "hello world")).toBe(
      "say hello world",
    );
    expect(rebaseText("a b c", "a B c", "a b C")).toBe("a B C");
  });

  it("没人改过就是我的；我没改就是别人的", () => {
    expect(rebaseText("x", "xy", "x")).toBe("xy");
    expect(rebaseText("x", "x", "zx")).toBe("zx");
  });

  it("改的是同一段时以我的为准", () => {
    expect(rebaseText("abc", "aXc", "aYc")).toBe("aXc");
  });
});
