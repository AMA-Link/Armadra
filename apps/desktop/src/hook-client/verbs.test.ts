import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { VERBS as BROWSER_ROUTE_VERBS } from "../core/browser/args.js";
import { EDGE_ROLES } from "../core/canvas/validation.js";
import { VERBS as CONTEXT_ROUTE_VERBS } from "../core/collab/context-link.js";
import type { Caller } from "../core/collab/nodes.js";
import {
  NODE_PALETTE,
  VERBS as CONTROL_VERBS,
  createControlDispatcher,
} from "../core/collab/control/index.js";
import type { CollabContext } from "../core/collab/service.js";
import { INBOX_WAKE_MODES } from "../core/collab/wake.js";
import { DEPENDENCY_CONDITIONS } from "../core/dependencies/store.js";
import { render } from "../cli/armadra-hook/control.js";
import {
  BROWSER_VERBS,
  CONTEXT_VERBS,
  USAGE,
} from "../cli/armadra-hook/usage.js";
import type { HookResponse } from "./http.js";
import {
  ENUMS,
  SESSION_BOARD_HIDDEN_VERBS,
  VERB_TOOLS,
  toWireArgs,
  toolByName,
  toolsForBoardKind,
} from "./verbs.js";

const verbsOf = (group: string): string[] =>
  VERB_TOOLS.filter((tool) => tool.group === group).map((tool) => tool.verb);

/**
 * The verb list `armadra-hook canvas help` prints: the runtime's answer to
 * `help`, rendered the way the CLI renders it, last line parsed back.
 */
async function canvasHelpVerbs(): Promise<string[]> {
  const dispatcher = createControlDispatcher({} as CollabContext);
  const caller = {
    node: { id: "n1", title: "t" },
    verdict: "verified",
  } as unknown as Caller;
  const outcome = await dispatcher.dispatch("help", caller, {});
  if (!outcome.ok) throw new Error(outcome.message);
  const printed = render({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(outcome.body),
  } as HookResponse);
  const line = printed
    .split("\n")
    .find((each) => each.includes("可用画布动词："));
  if (line === undefined) throw new Error(printed);
  const listed = line.split("可用画布动词：")[1]!.split(" / ");
  expect(listed).toEqual((outcome.body.result as { verbs: string[] }).verbs);
  return listed;
}

describe("the verb tool table", () => {
  it("has exactly the canvas verbs `armadra-hook canvas help` lists", async () => {
    const help = await canvasHelpVerbs();
    expect(verbsOf("canvas")).toEqual([...CONTROL_VERBS]);
    expect(new Set(verbsOf("canvas"))).toEqual(new Set(help));
  });

  it("has exactly the context and browser verbs of `armadra-hook --help`", () => {
    expect(verbsOf("context")).toEqual([...CONTEXT_VERBS]);
    expect(verbsOf("context")).toEqual([...CONTEXT_ROUTE_VERBS]);
    expect(verbsOf("browser")).toEqual([...BROWSER_VERBS]);
    expect(verbsOf("browser")).toEqual([...BROWSER_ROUTE_VERBS]);
    for (const verb of [...CONTEXT_VERBS, ...BROWSER_VERBS]) {
      expect(USAGE).toMatch(new RegExp(`\\n  ${verb}\\b`));
    }
  });

  it("gives every tool a unique, portable name and a route", () => {
    const names = VERB_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of VERB_TOOLS) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
      expect(tool.description.trim()).not.toBe("");
      const prefix = {
        canvas: "/control/",
        context: "/context-link/",
        browser: "/browser/",
      }[tool.group];
      expect(tool.path).toBe(`${prefix}${tool.verb}`);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const key of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties).toHaveProperty(key);
      }
    }
  });

  it("copies the runtime's enum values verbatim", () => {
    expect(ENUMS.edgeRoles).toEqual([...EDGE_ROLES]);
    expect(ENUMS.afterTurn).toEqual([...DEPENDENCY_CONDITIONS]);
    expect(ENUMS.inboxWake).toEqual([...INBOX_WAKE_MODES]);
    expect(ENUMS.palette).toEqual([...NODE_PALETTE]);
  });

  it("leaves the session binding to the caller", () => {
    for (const verb of ["ack", "handoff-read"]) {
      const tool = toolByName(`canvas_${verb.replace("-", "_")}`)!;
      expect(tool.binding).toBe("session");
      expect(tool.inputSchema.properties).not.toHaveProperty("sessionId");
      expect(tool.inputSchema.properties).not.toHaveProperty("generation");
    }
  });

  it("lets handoff-read choose the brief or the bundle", () => {
    const tool = toolByName("canvas_handoff_read")!;
    expect(tool.inputSchema.properties?.["format"]).toMatchObject({
      enum: ["md", "json"],
    });
    expect(tool.inputSchema.required).toEqual(["id"]);
  });

  it("types workflow-run: file required, params an object, open-agent takes a tier", () => {
    const run = toolByName("canvas_workflow_run")!;
    expect(run.inputSchema.required).toEqual(["file"]);
    expect(run.inputSchema.properties?.["params"]).toMatchObject({
      type: "object",
    });
    expect(toWireArgs(run, { file: "flow", params: { scope: "src" } })).toEqual(
      { ok: { file: "flow", params: { scope: "src" } } },
    );
    expect(toWireArgs(run, {})).toHaveProperty("error");
    expect(
      toolByName("canvas_open_agent")!.inputSchema.properties,
    ).toHaveProperty("tier");
  });

  it("marks browser tools long and generates their flags from the spec", () => {
    const click = toolByName("browser_click")!;
    expect(click.long).toBe(true);
    expect(click.inputSchema.properties).toHaveProperty("ref");
    expect(click.inputSchema.properties).toHaveProperty("node");
  });
});

describe("wire arguments", () => {
  const openAgent = toolByName("canvas_open_agent")!;

  it("sends what the CLI would: strings, true, string arrays", () => {
    expect(
      toWireArgs(openAgent, {
        agent: "codex",
        ttl: 30,
        after: ["a", "b"],
        "dry-run": true,
      }),
    ).toEqual({
      ok: { agent: "codex", ttl: "30", after: ["a", "b"], "dry-run": true },
    });
  });

  it("drops false switches and wraps a single array value", () => {
    expect(
      toWireArgs(openAgent, { agent: "codex", after: "a", "dry-run": false }),
    ).toEqual({ ok: { agent: "codex", after: ["a"] } });
  });

  it("refuses unknown keys, wrong kinds, bad enums and missing required", () => {
    expect(toWireArgs(openAgent, { agent: "x", nope: 1 })).toHaveProperty(
      "error",
    );
    expect(toWireArgs(openAgent, { agent: 3 })).toHaveProperty("error");
    expect(
      toWireArgs(openAgent, { agent: "x", "after-turn": "later" }),
    ).toHaveProperty("error");
    expect(toWireArgs(openAgent, {})).toHaveProperty("error");
    expect(toWireArgs(openAgent, [])).toHaveProperty("error");
  });

  it("accepts no arguments for a verb with none", () => {
    expect(toWireArgs(toolByName("canvas_list")!, undefined)).toEqual({
      ok: {},
    });
  });
});

describe("the shared client", () => {
  it("imports nothing from the CLI and only dependency-free modules from core", () => {
    const dir = import.meta.dirname;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(
        /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gms,
      )) {
        const [, typeOnly, specifier] = match;
        expect(specifier, file).not.toMatch(/cli\//);
        if (specifier!.startsWith("../core/") && typeOnly === undefined) {
          // The verb spec, and the pipe handshake: both are pure and import
          // nothing but node built-ins, so bundling them adds no dependency.
          expect(
            [
              "../core/browser/verb-spec.js",
              "../core/private-pipe/handshake.js",
              "../core/private-pipe/labels.js",
              "../core/collab/control/session-board-verbs.js",
            ],
            file,
          ).toContain(specifier);
        }
      }
    }
  });
});

describe("toolsForBoardKind (Armadra#1062 S4)", () => {
  it("lists everything off a sessions board", () => {
    expect(toolsForBoardKind(undefined)).toBe(VERB_TOOLS);
    expect(toolsForBoardKind("canvas")).toBe(VERB_TOOLS);
  });

  it("drops the canvas-only verbs and every browser verb on a sessions board", () => {
    const names = toolsForBoardKind("sessions").map((tool) => tool.name);
    for (const verb of SESSION_BOARD_HIDDEN_VERBS) {
      expect(names).not.toContain(`canvas_${verb.replace(/-/g, "_")}`);
    }
    expect(names.some((name) => name.startsWith("browser_"))).toBe(false);
    expect(names).toContain("canvas_open_agent");
    expect(names).toContain("canvas_send");
    expect(names).toContain("context_summary");
  });
});
