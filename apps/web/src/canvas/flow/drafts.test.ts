import { afterEach, describe, expect, it } from "vitest";

import {
  clearAllDrafts,
  clearDrafts,
  getDrafts,
  setDraft,
  setDrafts,
  subscribeDrafts,
} from "./drafts";

/**
 * 手势草稿（React Flow 计划 §2.1 规则 2）。
 *
 * 它存在的唯一理由是「一次手势一条历史」，所以两条不变量：位置与尺寸能
 * 分别写而不互相抹掉，值没变时不换对象（否则投影的身份缓存整块失效）。
 */

afterEach(clearAllDrafts);

describe("setDraft", () => {
  it("位置与尺寸分开写，互不覆盖", () => {
    setDraft("a", { position: { x: 1, y: 2 } });
    setDraft("a", { size: { width: 30, height: 40 } });
    expect(getDrafts().get("a")).toEqual({
      position: { x: 1, y: 2 },
      size: { width: 30, height: 40 },
    });
  });

  it("值没变就不换 Map：投影的身份缓存不该被无谓地打穿", () => {
    setDraft("a", { position: { x: 1, y: 2 } });
    const first = getDrafts();
    setDraft("a", { position: { x: 1, y: 2 } });
    expect(getDrafts()).toBe(first);
  });

  it("值变了就换一份新的 Map", () => {
    setDraft("a", { position: { x: 1, y: 2 } });
    const first = getDrafts();
    setDraft("a", { position: { x: 9, y: 2 } });
    expect(getDrafts()).not.toBe(first);
  });
});

describe("setDrafts", () => {
  it("多条一次写进去，只发布一次（多选拖动的每一帧）", () => {
    let published = 0;
    const release = subscribeDrafts(() => {
      published += 1;
    });
    try {
      setDrafts([
        ["a", { position: { x: 1, y: 2 } }],
        ["b", { position: { x: 3, y: 4 } }],
        ["c", { position: { x: 5, y: 6 } }],
      ]);
      expect(published).toBe(1);
      expect([...getDrafts().keys()]).toEqual(["a", "b", "c"]);
      expect(getDrafts().get("b")).toEqual({ position: { x: 3, y: 4 } });
    } finally {
      release();
    }
  });

  it("与已有草稿合并，值都没变时不换 Map、不发布", () => {
    setDraft("a", { size: { width: 30, height: 40 } });
    setDrafts([["a", { position: { x: 1, y: 2 } }]]);
    expect(getDrafts().get("a")).toEqual({
      position: { x: 1, y: 2 },
      size: { width: 30, height: 40 },
    });
    const first = getDrafts();
    let published = 0;
    const release = subscribeDrafts(() => {
      published += 1;
    });
    try {
      setDrafts([["a", { position: { x: 1, y: 2 } }]]);
      setDrafts([]);
      expect(getDrafts()).toBe(first);
      expect(published).toBe(0);
    } finally {
      release();
    }
  });
});

describe("clearDrafts", () => {
  it("只清点名的那些", () => {
    setDraft("a", { position: { x: 1, y: 1 } });
    setDraft("b", { position: { x: 2, y: 2 } });
    clearDrafts(["a"]);
    expect(getDrafts().has("a")).toBe(false);
    expect(getDrafts().has("b")).toBe(true);
  });

  it("清不存在的 id 不换对象", () => {
    setDraft("a", { position: { x: 1, y: 1 } });
    const first = getDrafts();
    clearDrafts(["ghost"]);
    expect(getDrafts()).toBe(first);
  });

  it("清空之后是同一个共享的空 Map", () => {
    const empty = getDrafts();
    setDraft("a", { position: { x: 1, y: 1 } });
    clearDrafts(["a"]);
    expect(getDrafts()).toBe(empty);
  });
});
