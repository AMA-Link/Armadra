import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acpAdapter, acpSessionMeta, type AcpAdapter } from "./adapters";
import { acpCanvasRules } from "./canvas-rules";
import { type AcpHostSession, startAcp } from "./host";
import { CANVAS_MCP_NAME } from "./mcp";

/**
 * grok / agy 的会话 `_meta`（Armadra#1035）：适配器表 → `acpSessionMeta` → 经真实
 * `AcpClient` 发到 `session/new|load|resume` 的线路上。一个脚本化的假 agent 把收到的
 * `_meta` 记进日志。
 */

const AGENT = `
const fs = require("node:fs");
const log = process.argv[2];
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, authMethods: [] });
        break;
      case "session/new":
      case "session/load":
      case "session/resume":
        fs.appendFileSync(log, JSON.stringify({ method: message.method, meta: message.params._meta ?? null }) + "\\n");
        reply(message.method === "session/new" ? { sessionId: "s-1" } : {});
        break;
      default:
        if (message.id !== undefined) reply({});
    }
  }
});
`;

const sessions: AcpHostSession[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.process.terminate()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "armadra-test-meta-wire-"));
  dirs.push(dir);
  const script = join(dir, "agent.cjs");
  const log = join(dir, "log.jsonl");
  writeFileSync(script, AGENT);
  writeFileSync(log, "");
  return {
    logged: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { method: string; meta: unknown }),
    async open(
      agentId: string,
      sessionMeta: ReturnType<typeof acpSessionMeta>,
      resume?: { sessionId: string; method: "load" | "resume" },
      onNew = false,
    ) {
      const session = await startAcp({
        program: process.execPath,
        args: [script, log],
        cwd: tmpdir(),
        agentId,
        ...(sessionMeta === undefined ? {} : { sessionMeta }),
        ...(onNew ? { sessionMetaOnNew: true } : {}),
        ...(resume === undefined ? {} : { resume }),
      });
      sessions.push(session);
      return session;
    },
  };
}

const grok = acpAdapter("grok") as AcpAdapter;
const agy = acpAdapter("agy") as AcpAdapter;
const INSTRUCTIONS = acpCanvasRules();

describe("canvas instructions", () => {
  it("name the MCP server and the canvas_* tools, in both languages, and stay short", () => {
    expect(INSTRUCTIONS).toContain(`\`${CANVAS_MCP_NAME}\``);
    for (const prefix of ["canvas_*", "context_*", "browser_*"]) {
      expect(INSTRUCTIONS).toContain(prefix);
    }
    expect(INSTRUCTIONS).toMatch(/画布/);
    expect(INSTRUCTIONS).toMatch(/Armadra board/);
    expect(INSTRUCTIONS.length).toBeLessThan(700);
  });
});

describe("the adapter table's session _meta", () => {
  it("grok: the instructions go into _meta.rules, nothing else (no yoloMode, no pluginDirs)", () => {
    expect(grok.metaVerified).toBe(true);
    for (const mode of ["default", "full-auto", "plan"] as const) {
      expect(
        acpSessionMeta(grok, {
          mode,
          instructions: INSTRUCTIONS,
          pluginDirs: ["/x"],
        }),
      ).toEqual({ rules: INSTRUCTIONS });
    }
    expect(acpSessionMeta(grok, { mode: "default" })).toBeUndefined();
    expect(
      acpSessionMeta(grok, { mode: "default", instructions: "  " }),
    ).toBeUndefined();
  });

  it("agy: the shape is written but gated off until it is verified", () => {
    expect(agy.metaVerified).toBe(false);
    expect(agy.sessionMeta?.({ mode: "default", instructions: "x" })).toEqual({
      antigravity: { systemPrompt: { append: "x" } },
    });
    // 没核实：一个键都不发。
    expect(
      acpSessionMeta(agy, { mode: "default", instructions: "x" }),
    ).toBeUndefined();
    // 核实之后翻开关（只改这一个标志）就发。
    expect(
      acpSessionMeta(
        { ...agy, metaVerified: true },
        { mode: "default", instructions: "x" },
      ),
    ).toEqual({ antigravity: { systemPrompt: { append: "x" } } });
  });

  it("an adapter without sessionMeta never sends one", () => {
    for (const id of ["claude", "codex", "copilot", "ama"]) {
      const adapter = acpAdapter(id);
      if (adapter === undefined) continue;
      expect(
        acpSessionMeta(adapter, { mode: "default", instructions: "x" }),
      ).toBeUndefined();
    }
  });
});

describe("through the real client", () => {
  it("session/new carries grok's _meta.rules", async () => {
    const r = rig();
    await r.open(
      "grok",
      acpSessionMeta(grok, { mode: "default", instructions: INSTRUCTIONS }),
    );
    expect(r.logged()).toEqual([
      { method: "session/new", meta: { rules: INSTRUCTIONS } },
    ]);
  });

  it("session/load and session/resume carry no rules for grok (they are ignored there; only session/new counts)", async () => {
    for (const method of ["load", "resume"] as const) {
      const r = rig();
      const session = await r.open(
        "grok",
        acpSessionMeta(grok, { mode: "default", instructions: INSTRUCTIONS }),
        { sessionId: "s-1", method },
        grok.metaOnNew === true,
      );
      expect(r.logged()).toEqual([{ method: `session/${method}`, meta: null }]);
      expect(session.metaInjected).toBe(true);
    }
    expect(grok.metaOnNew).toBe(true);
  });

  it("an adapter without metaOnNew keeps sending it on load / resume (the opener default)", async () => {
    const r = rig();
    await r.open(
      "agy",
      { antigravity: { systemPrompt: { append: "x" } } },
      { sessionId: "s-1", method: "load" },
      false,
    );
    expect(r.logged()).toEqual([
      {
        method: "session/load",
        meta: { antigravity: { systemPrompt: { append: "x" } } },
      },
    ]);
  });

  it("agy sends no _meta at all while it is unverified (the wire is as before)", async () => {
    const r = rig();
    await r.open(
      "agy",
      acpSessionMeta(agy, { mode: "default", instructions: INSTRUCTIONS }),
    );
    expect(r.logged()).toEqual([{ method: "session/new", meta: null }]);
  });
});
