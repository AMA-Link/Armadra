/**
 * The canvas, context and browser verbs as ama tools — generated from
 * `hook-client/verbs.ts`'s `VERB_TOOLS`, the table `armadra-hook mcp` reads
 * too, never copied by hand (docs/design/coordinator-agent.md §3).
 *
 * Each tool is one `POST /control/<verb>`, `/context-link/<verb>` or
 * `/browser/<verb>` through {@link callVerb}. What the adapter adds is the
 * permission class ama's pipeline sorts the call by. Board and context verbs
 * are filed `read`, so they run unasked like the same verbs on every other
 * agent's node (contract §107); stopping or closing another agent and the
 * browser's file transfers are `execute`, and the remaining browser verbs
 * `write` — asked for in ama's default mode. The adapter never answers an
 * approval itself.
 */

import type {
  HostApi,
  ToolDefinition,
  ToolPermission,
  ToolResult,
} from "@armadra/agent/host";
import {
  type JsonSchema,
  VERB_TOOLS,
  type VerbTool,
} from "../../hook-client/verbs.js";
import { type CallOutcome, callVerb } from "./client.js";

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
export function readsOnly(tool: VerbTool): boolean {
  return READ[tool.group]?.includes(tool.verb) === true;
}

/**
 * The class ama's permission pipeline files a verb under. `read` is the one
 * class every mode allows, so board verbs take it even when they change the
 * board; a browser verb outside both tables is `write`, asked for in the
 * default mode.
 */
export function permissionOf(tool: VerbTool): ToolPermission {
  if (EXECUTE[tool.group]?.includes(tool.verb) === true) return "execute";
  if (readsOnly(tool) || UNASKED.has(tool.group)) return "read";
  return "write";
}

export type Caller = (tool: VerbTool, input: unknown) => Promise<CallOutcome>;

/**
 * The JSON Schema keywords ama accepts in a tool's parameters (its
 * `agent/schema.ts` subset): a host tool with any other keyword makes
 * `create()` fail and ama exit 6. Measured against 0.6.2.
 */
export const AMA_SCHEMA_KEYWORDS = [
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "default",
] as const;

/**
 * The verb table's schema in ama's subset. A bound the subset cannot state
 * (`minimum`, `minItems`) moves into the description, where the model still
 * reads it; the runtime enforces it either way and answers a precise refusal.
 */
export function amaSchema(schema: JsonSchema): ToolDefinition["parameters"] {
  const notes: string[] = [];
  if (schema.minimum !== undefined) notes.push(`≥ ${schema.minimum}`);
  if (schema.minItems !== undefined) notes.push(`at least ${schema.minItems}`);
  const out: Record<string, unknown> = {};
  if (schema.type !== undefined) out.type = schema.type;
  const description = [schema.description, ...notes]
    .filter((part) => part !== undefined && part !== "")
    .join("; ");
  if (description !== "") out.description = description;
  if (schema.enum !== undefined) out.enum = [...schema.enum];
  if (schema.items !== undefined) out.items = amaSchema(schema.items);
  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        amaSchema(child),
      ]),
    );
  }
  if (schema.required !== undefined) out.required = [...schema.required];
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out as ToolDefinition["parameters"];
}

/** One verb as an ama tool definition. */
export function toolDefinition(
  tool: VerbTool,
  call: Caller = callVerb,
): ToolDefinition {
  const permission = permissionOf(tool);
  return {
    name: tool.name,
    label: `${tool.group} ${tool.verb}`,
    description: tool.description,
    parameters: amaSchema(tool.inputSchema),
    permission,
    annotations: {
      readOnly: readsOnly(tool),
      destructive: permission === "execute",
      openWorld: tool.group === "browser",
    },
    async execute(input: unknown): Promise<ToolResult> {
      try {
        const outcome = await call(tool, input);
        return "ok" in outcome
          ? { content: outcome.ok === "" ? "ok" : outcome.ok }
          : { content: outcome.error, isError: true };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

/** Every verb as a tool, in the table's order (canvas, context, browser). */
export function canvasTools(call: Caller = callVerb): ToolDefinition[] {
  return VERB_TOOLS.map((tool) => toolDefinition(tool, call));
}

/**
 * The longest a coordinator's `canvas_wait` may hold the call (seconds).
 * Its input arrives by wake-ups, so it must not block on one member; ama's
 * own `task_ctl wait` is capped to the same 5 s in the coordinator preset.
 */
export const COORDINATOR_WAIT_CAP_SECONDS = 5;

/** Built-in tools whose absence makes a node the coordinator (preset `coordinator`: `read` only). */
const WRITING_TOOLS = ["bash", "edit", "write"] as const;

/**
 * Whether ama runs the coordinator preset: it has `read` and none of bash /
 * edit / write. Asked at call time, not at `create`, so the answer reflects
 * the tool set the session really settled on.
 */
export function isCoordinator(api: Pick<HostApi, "tools">): boolean {
  const names = api.tools.list();
  return (
    names.includes("read") &&
    WRITING_TOOLS.every((name) => !names.includes(name))
  );
}

/** `canvas_wait`'s arguments with `timeout` held to the cap (absent means the cap). */
export function capWaitInput(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const given = (input as Record<string, unknown>).timeout;
  const seconds =
    typeof given === "number"
      ? given
      : typeof given === "string" && /^\d{1,4}$/.test(given.trim())
        ? Number(given.trim())
        : Number.NaN;
  const timeout = Number.isFinite(seconds)
    ? Math.min(Math.max(0, Math.trunc(seconds)), COORDINATOR_WAIT_CAP_SECONDS)
    : COORDINATOR_WAIT_CAP_SECONDS;
  return { ...(input as Record<string, unknown>), timeout };
}

/** Registers every tool; answers the names. */
export function registerTools(
  api: Pick<HostApi, "tools">,
  call: Caller = callVerb,
): string[] {
  const capped: Caller = (tool, input) =>
    tool.group === "canvas" && tool.verb === "wait" && isCoordinator(api)
      ? call(tool, capWaitInput(input))
      : call(tool, input);
  const names: string[] = [];
  for (const tool of canvasTools(capped)) {
    api.tools.register(tool);
    names.push(tool.name);
  }
  return names;
}
