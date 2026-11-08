import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../hook-client/json";
import type { ControlAnswer } from "./client";
import {
  ORIGIN_SEGMENT_CAP,
  READ_CAP_LINES,
  RESOURCE_DESCRIBE,
  RESOURCE_SCHEME,
  type ResourceDefinition,
  TOOLS_HIDDEN_BY_RESOURCES,
  VERB_PAGE_LIMIT,
  hasResources,
  pageLines,
  readResource,
  registerResources,
  resolvePath,
} from "./resources";

/**
 * The `armadra://` namespace against a scripted core (#885): how ama's line
 * window becomes the verbs' row window, that a wide read walks every server
 * page and pages join back to the whole, and what becomes an error.
 */

type Call = { verb: string; args: Record<string, JsonValue> };

function scripted(
  answer: (call: Call) => ControlAnswer | Promise<ControlAnswer>,
) {
  const calls: Call[] = [];
  const control = vi.fn(
    async (verb: string, args: Record<string, JsonValue>) => {
      const call = { verb, args };
      calls.push(call);
      return answer(call);
    },
  );
  return { calls, control };
}

const ok = (message: string, result: unknown): ControlAnswer => ({
  kind: "ok",
  body: { ok: true, message, result },
});

const signal = new AbortController().signal;
const opt = (offset: number, limit?: number) => ({ offset, limit, signal });

/**
 * A ledger of `n` items behind the real `items` verb's paging: `--offset`
 * rows skipped, `--limit` ≤ 50, one line per row and the trailer the verb
 * writes (contract §90.3).
 */
function ledger(n: number) {
  const rows = Array.from(
    { length: n },
    (_, i) => `wi-${i + 1} · 任务 ${i + 1} · node · working · -`,
  );
  return scripted(({ verb, args }) => {
    if (verb !== "items") throw new Error(`unexpected ${verb}`);
    const offset = Number(args.offset ?? 0);
    const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
    const page = rows.slice(offset, offset + limit);
    const next = offset + page.length < n ? offset + page.length : null;
    const message =
      n === 0
        ? "账本里没有工作项。"
        : `${page.join("\n")}\n共 ${n} 项，第 ${offset + 1}–${offset + page.length} 项。` +
          (next === null ? "" : `接着读：\`canvas items --offset ${next}\`。`) +
          "\n单项详情：`canvas items --item <id>`。";
    return ok(message, {
      items: page.map((_, i) => ({ id: `wi-${offset + i + 1}` })),
      total: n,
      offset,
      next,
    });
  });
}

describe("the armadra scheme", () => {
  it("is one lowercase scheme with a one-line description ama accepts", () => {
    expect(RESOURCE_SCHEME).toMatch(/^[a-z][a-z0-9+.-]{1,31}$/);
    expect(RESOURCE_DESCRIBE).not.toContain("\n");
    expect(RESOURCE_DESCRIBE.length).toBeLessThanOrEqual(120);
    for (const path of ["items", "items/<id>", "events"]) {
      expect(RESOURCE_DESCRIBE).toContain(`armadra://${path}`);
    }
    expect([...TOOLS_HIDDEN_BY_RESOURCES]).toEqual([
      "canvas_items",
      "canvas_events",
    ]);
  });

  it("knows four paths and nothing else", () => {
    expect(resolvePath("items")).toEqual({ kind: "items" });
    expect(resolvePath("events")).toEqual({ kind: "events" });
    expect(resolvePath("items/wi-7")).toEqual({ kind: "item", id: "wi-7" });
    expect(resolvePath("items/wi-7/origin")).toEqual({
      kind: "origin",
      id: "wi-7",
    });
    for (const path of [
      "",
      "item",
      "items/",
      "items/a/b",
      "items/a/origin/x",
      "inbox",
      "Items",
    ]) {
      expect(resolvePath(path), path).toBeUndefined();
    }
  });
});

describe("paging", () => {
  const text = "one\ntwo\nthree\nfour\nfive\n";

  it("follows ama's rule: 1-based first line, at most limit lines, one trailing newline is no line", () => {
    expect(pageLines(text, { offset: 1 })).toEqual({
      text: "one\ntwo\nthree\nfour\nfive",
      total: 5,
    });
    expect(pageLines(text, { offset: 2, limit: 2 })).toEqual({
      text: "two\nthree",
      next: 4,
      total: 5,
    });
    expect(pageLines(text, { offset: 4, limit: 10 })).toEqual({
      text: "four\nfive",
      total: 5,
    });
    expect(pageLines(text, { offset: 9, limit: 2 })).toEqual({
      text: "",
      total: 5,
    });
    expect(pageLines("", { offset: 1 })).toEqual({ text: "", total: 0 });
    expect(pageLines("a\r\nb\rc", { offset: 1 })).toEqual({
      text: "a\nb\nc",
      total: 3,
    });
  });
});

describe("armadra://items", () => {
  it("reads a ledger of more than one server page whole, with the server's total", async () => {
    const { calls, control } = ledger(120);
    const page = await readResource("items", opt(1), control);
    expect(page?.total).toBe(120);
    expect(page?.next).toBeUndefined();
    const lines = page?.text.split("\n") ?? [];
    expect(lines).toHaveLength(120);
    expect(lines[0]).toMatch(/^wi-1 · /);
    expect(lines[119]).toMatch(/^wi-120 · /);
    // No trailer, no hint at a hidden tool.
    expect(page?.text).not.toContain("canvas items");
    expect(page?.text).not.toContain("共 120 项");
    // Three server pages of 50 rows: 0, 50, 100.
    expect(calls.map((call) => call.args)).toEqual([
      { offset: 0, limit: 50 },
      { offset: 50, limit: 50 },
      { offset: 100, limit: 50 },
    ]);
  });

  it("turns ama's line window into the row window and joins pages back", async () => {
    const { calls, control } = ledger(120);
    const first = await readResource("items", opt(1, 70), control);
    expect(first?.total).toBe(120);
    expect(first?.next).toBe(71);
    expect(first?.text.split("\n")).toHaveLength(70);
    // 70 lines = one page of 50 and one of 20.
    expect(calls.map((call) => call.args)).toEqual([
      { offset: 0, limit: 50 },
      { offset: 50, limit: 20 },
    ]);
    const second = await readResource("items", opt(71, 70), control);
    expect(second?.next).toBeUndefined();
    expect(second?.text.split("\n")).toHaveLength(50);
    expect(calls[2]?.args).toEqual({ offset: 70, limit: 50 });
    const whole = await readResource("items", opt(1), control);
    expect(`${first?.text}\n${second?.text}`).toBe(whole?.text);
  });

  it("answers an empty page past the end, the verb's sentence for an empty ledger", async () => {
    const past = await readResource("items", opt(500, 10), ledger(120).control);
    expect(past).toEqual({ text: "", total: 120 });
    const empty = await readResource("items", opt(1), ledger(0).control);
    expect(empty).toEqual({ text: "账本里没有工作项。", total: 1 });
  });

  it("stops at ama's own cut when no limit is given", async () => {
    const { calls, control } = ledger(READ_CAP_LINES + 10);
    const page = await readResource("items", opt(1), control);
    expect(page?.text.split("\n")).toHaveLength(READ_CAP_LINES);
    expect(page?.next).toBe(READ_CAP_LINES + 1);
    expect(calls).toHaveLength(READ_CAP_LINES / VERB_PAGE_LIMIT);
  });
});

describe("armadra://events", () => {
  function queue(n: number) {
    return scripted(({ verb, args }) => {
      if (verb !== "events") throw new Error(`unexpected ${verb}`);
      const limit = Math.min(50, Number(args.limit ?? 20));
      const open = Array.from(
        { length: Math.min(n, limit) },
        (_, i) => `ev-${i + 1} · wi-${i + 1} · report · ready`,
      );
      const message =
        n === 0
          ? "没有未确认的事件。"
          : `${open.join("\n")}\n共 ${n} 条未确认。\n确认：\`canvas ack --event <事件 id>\`。`;
      return ok(message, {
        events: open.map((_, i) => ({ id: `ev-${i + 1}` })),
        total: n,
      });
    });
  }

  it("takes the verb's largest page and pages it by lines, joining back", async () => {
    const { calls, control } = queue(25);
    const pages: string[] = [];
    let offset: number | undefined = 1;
    while (offset !== undefined) {
      const page = await readResource("events", opt(offset, 10), control);
      if (page === undefined) throw new Error("no page");
      expect(page.total).toBe(25);
      pages.push(page.text);
      offset = page.next;
    }
    expect(pages.map((page) => page.split("\n").length)).toEqual([10, 10, 5]);
    const whole = await readResource("events", opt(1), control);
    expect(pages.join("\n")).toBe(whole?.text);
    expect(whole?.text).not.toContain("canvas ack");
    expect(calls.every((call) => call.args.limit === VERB_PAGE_LIMIT)).toBe(
      true,
    );
  });

  it("says how many more are open than the verb lists, and reads an empty queue", async () => {
    const page = await readResource("events", opt(1), queue(60).control);
    const lines = page?.text.split("\n") ?? [];
    expect(lines).toHaveLength(51);
    expect(lines[50]).toContain("还有 10 条");
    expect(lines[50]).toContain("canvas_ack");
    expect(page?.total).toBe(51);
    expect(await readResource("events", opt(1), queue(0).control)).toEqual({
      text: "没有未确认的事件。",
      total: 1,
    });
  });
});

describe("armadra://items/<id> and its origin", () => {
  /** One item whose origin text is `segments` 2048-byte pieces long. */
  function item(id: string, origin: string) {
    const bytes = Buffer.from(origin, "utf8");
    return scripted(({ verb, args }) => {
      if (verb !== "items" || args.item !== id) {
        return {
          kind: "refused",
          status: 404,
          code: "item_not_found",
          message: `没有工作项 \`${String(args.item)}\`。`,
        };
      }
      const from = Number(args.offset ?? 0);
      const to = Math.min(bytes.length, from + 2048);
      const text = bytes.subarray(from, to).toString("utf8");
      const next = to < bytes.length ? to : null;
      const lines = [
        `${id} · 标题`,
        "节点：member（n1） · 阶段：working · 状态：running",
        "来源：issue AMA-Link/x#1",
        `来源原文（第 ${from}–${to} 字节，共 ${bytes.length} 字节）：`,
        text,
      ];
      if (next !== null) {
        lines.push(`接着读：\`canvas items --item ${id} --offset ${next}\`。`);
      }
      lines.push("报告历史：", "- t1 progress: 开始");
      return ok(lines.join("\n"), {
        id,
        origin: {
          kind: "issue",
          ref: "x#1",
          text,
          from,
          to,
          size: bytes.length,
          next,
        },
        reports: [],
      });
    });
  }
  const origin = Array.from(
    { length: 300 },
    (_, i) => `line ${i + 1} ${"x".repeat(20)}`,
  ).join("\n");

  it("rewrites the detail's origin pointer for read", async () => {
    const { calls, control } = item("wi-7", origin);
    const page = await readResource("items/wi-7", opt(1), control);
    expect(calls).toEqual([{ verb: "items", args: { item: "wi-7" } }]);
    expect(page?.text).toContain("wi-7 · 标题");
    expect(page?.text).toContain(
      "来源全文：`read armadra://items/wi-7/origin`。",
    );
    expect(page?.text).not.toContain("canvas items");
    expect(page?.text).toContain("- t1 progress: 开始");
  });

  it("follows the origin's byte segments to the whole text and pages it by lines", async () => {
    const { calls, control } = item("wi-7", origin);
    const whole = await readResource("items/wi-7/origin", opt(1), control);
    expect(whole?.text).toBe(origin);
    expect(whole?.total).toBe(300);
    // 300 lines × 28 bytes ≈ 8.3 KB: five segments, each asked by the byte
    // offset the previous one answered.
    expect(calls.map((call) => call.args.offset)).toEqual([
      0, 2048, 4096, 6144, 8192,
    ]);
    const pages: string[] = [];
    let offset: number | undefined = 1;
    while (offset !== undefined) {
      const page = await readResource(
        "items/wi-7/origin",
        opt(offset, 120),
        control,
      );
      if (page === undefined) throw new Error("no page");
      pages.push(page.text);
      offset = page.next;
    }
    expect(pages.join("\n")).toBe(origin);
  });

  it("keeps to the segment cap and answers a sentence when there is no origin", async () => {
    const stuck = scripted(() => ok("x", { origin: { text: "a", next: 0 } }));
    // A pointer that does not advance stops at once; a long one at the cap.
    expect(await readResource("items/w/origin", opt(1), stuck.control)).toEqual(
      {
        text: "a",
        total: 1,
      },
    );
    let n = 0;
    const endless = scripted(() => {
      n += 1;
      return ok("x", { origin: { text: "a", next: n * 2048 } });
    });
    await readResource("items/w/origin", opt(1), endless.control);
    expect(n).toBe(ORIGIN_SEGMENT_CAP);
    const none = scripted(() => ok("w · t", { origin: null }));
    expect(await readResource("items/w/origin", opt(1), none.control)).toEqual({
      text: "没有来源原文。",
      total: 1,
    });
  });
});

describe("reading", () => {
  it("answers undefined for a path it does not have, without calling", async () => {
    const { calls, control } = scripted(() => ok("never", {}));
    expect(await readResource("inbox", opt(1), control)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("turns a refusal and a transport failure into thrown errors", async () => {
    const refused = scripted(() => ({
      kind: "refused",
      status: 404,
      code: "item_not_found",
      message: "没有工作项 `nope`。",
    }));
    await expect(
      readResource("items/nope", opt(1), refused.control),
    ).rejects.toThrow("没有工作项 `nope`。");
    const down = scripted(() => ({
      kind: "unreachable",
      error: "no endpoint answered",
    }));
    await expect(readResource("events", opt(1), down.control)).rejects.toThrow(
      "no endpoint answered",
    );
    const thrown = scripted(() => {
      throw new Error("boom");
    });
    await expect(readResource("items", opt(1), thrown.control)).rejects.toThrow(
      "boom",
    );
  });
});

describe("registration", () => {
  it("registers nothing on an ama without resources", () => {
    const log = vi.fn();
    expect(hasResources({ log })).toBe(false);
    expect(registerResources({ log }, scripted(() => ok("", {})).control)).toBe(
      false,
    );
    expect(hasResources({ log, resources: undefined })).toBe(false);
  });

  it("registers the scheme once, reading through the control caller", async () => {
    const registered: ResourceDefinition[] = [];
    const api = {
      log: vi.fn(),
      resources: {
        register: (resource: ResourceDefinition) => {
          registered.push(resource);
        },
        list: () => registered.map((resource) => resource.scheme),
      },
    };
    const { calls, control } = scripted(() =>
      ok("e1 · wi-7 · report · ready\n共 1 条未确认。", {
        events: [{ id: "e1" }],
        total: 1,
      }),
    );
    expect(hasResources(api)).toBe(true);
    expect(registerResources(api, control)).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.scheme).toBe(RESOURCE_SCHEME);
    expect(registered[0]?.describe).toBe(RESOURCE_DESCRIBE);
    const page = await registered[0]?.read("events", opt(1));
    expect(page).toEqual({ text: "e1 · wi-7 · report · ready", total: 1 });
    expect(calls).toEqual([
      { verb: "events", args: { limit: VERB_PAGE_LIMIT } },
    ]);
  });

  it("survives a register that throws and answers false", () => {
    const log = vi.fn();
    const api = {
      log,
      resources: {
        register: () => {
          throw new Error("frozen");
        },
        list: () => [],
      },
    };
    expect(registerResources(api, scripted(() => ok("", {})).control)).toBe(
      false,
    );
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.any(String),
      expect.anything(),
    );
  });
});
