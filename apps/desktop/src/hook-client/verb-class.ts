/**
 * The permission class of each canvas, context and browser verb, in one place
 * for every adapter that has to sort calls by it: ama's host adapter
 * (`agent-host/ama/tools.ts`) and the tools the omp extension registers
 * (`core/hook/install/extension-template.ts`, contract §110).
 *
 * Board and context verbs are filed `read`, so they run unasked like the same
 * verbs on every other agent's node (contract §107); stopping or closing
 * another agent and the browser's file transfers are `execute`, and the
 * remaining browser verbs `write`.
 */

import type { VerbTool } from "./verbs.js";

export type VerbClass = "read" | "write" | "execute";

/** Verbs that only read (the tool's `readOnly` annotation). */
const READ: Readonly<Record<string, readonly string[]>> = {
  canvas: [
    "help",
    "list",
    "inbox",
    "outbox",
    "handoff-read",
    "items",
    "events",
  ],
  // Every context verb reads a linked node; the budget is the core's.
  context: ["list", "summary", "transcript", "terminal"],
  browser: ["read", "wait", "capture", "pdf"],
};

/** Verbs that stop, close or reach outside the board. */
const EXECUTE: Readonly<Record<string, readonly string[]>> = {
  canvas: ["interrupt", "close"],
  context: [],
  browser: ["upload", "download", "close"],
};

/**
 * Groups whose verbs other than {@link EXECUTE} run unasked. Each one only
 * reaches nodes the link grants and carries this node's token, so the core
 * grants nothing extra; Claude, Codex, OpenCode and Copilot run them unasked
 * too (contract §105, §106).
 */
const UNASKED: ReadonlySet<string> = new Set(["canvas", "context"]);

/** Whether a verb only reads. */
export function verbReadsOnly(tool: VerbTool): boolean {
  return READ[tool.group]?.includes(tool.verb) === true;
}

/** The class a verb is filed under. */
export function verbClass(tool: VerbTool): VerbClass {
  if (EXECUTE[tool.group]?.includes(tool.verb) === true) return "execute";
  if (verbReadsOnly(tool) || UNASKED.has(tool.group)) return "read";
  return "write";
}
