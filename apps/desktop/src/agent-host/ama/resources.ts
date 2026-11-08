/**
 * The ledger and the event queue as one `armadra://` resource namespace
 * (host-api 1.2, AMA-Link/Armadra#885).
 *
 * With `api.resources` the coordinator reads them through ama's built-in
 * `read` — `armadra://items`, `armadra://items/<id>`,
 * `armadra://items/<id>/origin`, `armadra://events` — and the two read-only
 * tools `canvas_items` / `canvas_events` are hidden from it (`main.ts`), so
 * the tool table stops growing with every kind of data. Every read is still
 * `POST /control/items` or `/control/events` through {@link callControl}:
 * same node token, same session binding, same authorization as the tool and
 * as `armadra-hook canvas items`.
 *
 * ama pages a resource by lines (`offset` = first line, 1-based; `limit` = at
 * most that many lines). The ledger list is one line per item, so the line
 * window becomes the verb's own row window (`--offset` rows skipped,
 * `--limit` ≤ 50 rows) and a wide read walks as many server pages as it
 * needs; `total` and `next` come from the server's answer, never from the
 * page in hand. The verbs' "接着读 `canvas items …`" hints point at tools
 * the coordinator no longer has, so they are dropped or rewritten as
 * `read armadra://…`.
 *
 * Feature-detected: the pinned `@armadra/agent` has no `resources` yet, so
 * its surface is typed here from ama's contract (host-api.md, "宿主资源") and
 * an older ama keeps today's tools and instructions byte for byte.
 */

import type { HostApi } from "@armadra/agent/host";
import type { JsonValue } from "../../hook-client/json.js";
import { type ControlAnswer, callControl } from "./client.js";

/** The scheme the adapter registers: `armadra://…`. */
export const RESOURCE_SCHEME = "armadra";

/** The one-line description ama puts in the system prompt (≤ 120 characters). */
export const RESOURCE_DESCRIBE =
  "Work-item ledger and coordinator events: armadra://items, armadra://items/<id>[/origin], armadra://events";

/** The tools the resources replace, hidden from ama when the scheme is registered. */
export const TOOLS_HIDDEN_BY_RESOURCES = [
  "canvas_items",
  "canvas_events",
] as const;

/** The most rows one `items` / `events` call answers (contract §90.3, §93.3). */
export const VERB_PAGE_LIMIT = 50;

/** Lines one read gathers at most when ama gives no `limit` (ama's own cut is 2000). */
export const READ_CAP_LINES = 2000;

/** Origin segments one read follows at most (2048 bytes each: contract §90.3). */
export const ORIGIN_SEGMENT_CAP = 256;

/** What a host resource `read` is given (ama's `HostResourceReadOptions`). */
export interface ResourceReadOptions {
  /** First line, 1-based. */
  readonly offset: number;
  /** At most this many lines; absent means all. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** What a host resource `read` answers (ama's `HostResourceContent`). */
export interface ResourceContent {
  text: string;
  /** The next page's first line, when there is more. */
  next?: number;
  /** Total lines, when known. */
  total?: number;
}

/** A registered namespace (ama's `HostResource`). */
export interface ResourceDefinition {
  readonly scheme: string;
  readonly describe: string;
  read(
    path: string,
    options: ResourceReadOptions,
  ): ResourceContent | undefined | Promise<ResourceContent | undefined>;
}

/** `HostApi.resources` as host-api 1.2 adds it; absent on an older ama. */
export interface ResourcesApi {
  register(resource: ResourceDefinition): void;
  list(): readonly string[];
}

/** A `HostApi` that may carry the optional resources surface. */
export type HostApiWithResources = Pick<HostApi, "log"> & {
  readonly resources?: ResourcesApi;
};

/** `POST /control/<verb>` answered as data — `client.ts`'s `callControl`. */
export type Control = (
  verb: string,
  args: Record<string, JsonValue>,
) => Promise<ControlAnswer>;

/** Whether this ama has the resources surface (host-api ≥ 1.2). */
export function hasResources(
  api: HostApiWithResources,
): api is HostApiWithResources & { readonly resources: ResourcesApi } {
  return typeof api.resources?.register === "function";
}

/**
 * The lines of `text` from the `offset`-th on, at most `limit` of them —
 * ama's own paging rule (`\r\n` / `\r` become `\n`; one trailing newline is
 * not a line). Past the end the text is empty and there is no `next`.
 */
export function pageLines(
  text: string,
  options: { readonly offset?: number; readonly limit?: number },
): ResourceContent {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines =
    normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
  const offset = Math.max(1, Math.floor(options.offset ?? 1));
  const start = offset - 1;
  const end =
    options.limit === undefined
      ? lines.length
      : Math.min(lines.length, start + Math.max(0, Math.floor(options.limit)));
  const page = start >= lines.length ? [] : lines.slice(start, end);
  const out: ResourceContent = { text: page.join("\n"), total: lines.length };
  if (page.length > 0 && end < lines.length) out.next = end + 1;
  return out;
}

/** The resource paths, parsed. */
export type ResourcePath =
  | { readonly kind: "items" }
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "origin"; readonly id: string }
  | { readonly kind: "events" };

/** What a path stands for; `undefined` for no such path. */
export function resolvePath(path: string): ResourcePath | undefined {
  if (path === "items") return { kind: "items" };
  if (path === "events") return { kind: "events" };
  const item = /^items\/([^/?#]+)(\/origin)?$/.exec(path);
  if (item !== null && item[1] !== undefined) {
    return item[2] === undefined
      ? { kind: "item", id: item[1] }
      : { kind: "origin", id: item[1] };
  }
  return undefined;
}

/** A verb's answer, or the refusal / transport failure as a thrown error. */
async function answerOf(
  control: Control,
  verb: string,
  args: Record<string, JsonValue>,
): Promise<{ message: string; result: Record<string, unknown> }> {
  const answer = await control(verb, args);
  if (answer.kind === "refused") throw new Error(answer.message);
  if (answer.kind === "unreachable") throw new Error(answer.error);
  const result = answer.body.result;
  return {
    message: typeof answer.body.message === "string" ? answer.body.message : "",
    result:
      result !== null && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {},
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** The first `rows` lines of a verb's `message`: one per row, before its trailer. */
function rowLines(message: string, rows: number): string[] {
  if (rows === 0) return [];
  return message.replace(/\r\n?/g, "\n").split("\n").slice(0, rows);
}

/** The lines one read may still gather. */
function budget(options: ResourceReadOptions): number {
  return options.limit === undefined
    ? READ_CAP_LINES
    : Math.max(0, Math.floor(options.limit));
}

/**
 * `armadra://items`: ama's line window as the verb's row window, over as
 * many server pages as it takes. `total` is the server's count; `next` is
 * the server's next row as a 1-based line.
 */
async function readItems(
  control: Control,
  options: ResourceReadOptions,
): Promise<ResourceContent> {
  let remaining = budget(options);
  let row = Math.max(0, Math.floor(options.offset) - 1);
  const lines: string[] = [];
  let total: number | undefined;
  let more = false;
  let firstMessage: string | undefined;
  while (remaining > 0) {
    const { message, result } = await answerOf(control, "items", {
      offset: row,
      limit: Math.min(VERB_PAGE_LIMIT, remaining),
    });
    firstMessage ??= message;
    total = count(result.total) ?? total;
    const got = arrayLength(result.items);
    lines.push(...rowLines(message, got));
    remaining -= got;
    const next = count(result.next);
    if (next === undefined || got === 0) {
      more = false;
      break;
    }
    row = next;
    more = true;
  }
  if (total === 0 && lines.length === 0 && options.offset <= 1) {
    // "账本里没有工作项。" — the verb's own sentence, the one line there is.
    return pageLines(firstMessage ?? "", { offset: 1 });
  }
  const out: ResourceContent = { text: lines.join("\n") };
  if (total !== undefined) out.total = total;
  if (more && lines.length > 0) out.next = row + 1;
  return out;
}

/**
 * `armadra://events`: the verb has no row offset (contract §93.3), so one
 * call takes its largest page and ama's window is cut from that; when more
 * are open than fit, one closing line says so — the coordinator acknowledges
 * handled ones and reads again.
 */
async function readEvents(
  control: Control,
  options: ResourceReadOptions,
): Promise<ResourceContent> {
  const { message, result } = await answerOf(control, "events", {
    limit: VERB_PAGE_LIMIT,
  });
  const got = arrayLength(result.events);
  const total = count(result.total) ?? got;
  if (got === 0) return pageLines(message, options);
  const lines = rowLines(message, got);
  if (total > got) {
    lines.push(
      `还有 ${total - got} 条未列出：处理并用 canvas_ack 确认之后再读。/ ${total - got} more not listed: acknowledge handled ones with canvas_ack, then read again.`,
    );
  }
  return pageLines(lines.join("\n"), options);
}

/** The verb's "接着读" hint for the origin text, rewritten for `read`. */
const ORIGIN_HINT = /^接着读：`canvas items --item (.+) --offset \d+`。$/;

/** `armadra://items/<id>`: the detail, with the origin pointer in `read`'s words. */
async function readItem(
  control: Control,
  id: string,
  options: ResourceReadOptions,
): Promise<ResourceContent> {
  const { message } = await answerOf(control, "items", { item: id });
  const lines = message
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      ORIGIN_HINT.test(line)
        ? `来源全文：\`read armadra://items/${id}/origin\`。`
        : line,
    );
  return pageLines(lines.join("\n"), options);
}

/**
 * `armadra://items/<id>/origin`: the origin text whole — the verb's 2048-byte
 * segments followed by their `next` pointer and joined — then paged by lines.
 */
async function readOrigin(
  control: Control,
  id: string,
  options: ResourceReadOptions,
): Promise<ResourceContent> {
  const parts: string[] = [];
  let offset: number | undefined = 0;
  for (let n = 0; offset !== undefined && n < ORIGIN_SEGMENT_CAP; n += 1) {
    const { result } = await answerOf(control, "items", { item: id, offset });
    const origin = result.origin;
    if (origin === null || typeof origin !== "object") break;
    const segment = origin as Record<string, unknown>;
    if (typeof segment.text !== "string") break;
    parts.push(segment.text);
    const next = count(segment.next);
    // A pointer that does not advance would loop forever: stop instead.
    offset = next !== undefined && next > offset ? next : undefined;
  }
  if (parts.length === 0) return pageLines("没有来源原文。", options);
  return pageLines(parts.join(""), options);
}

/**
 * One resource read. A refusal or a transport failure is thrown — ama
 * answers the model with a tool error.
 */
export async function readResource(
  path: string,
  options: ResourceReadOptions,
  control: Control = callControl,
): Promise<ResourceContent | undefined> {
  const target = resolvePath(path);
  if (target === undefined) return undefined;
  switch (target.kind) {
    case "items":
      return readItems(control, options);
    case "events":
      return readEvents(control, options);
    case "item":
      return readItem(control, target.id, options);
    case "origin":
      return readOrigin(control, target.id, options);
  }
}

/**
 * Registers the `armadra` scheme when this ama has resources; answers whether
 * it did. Only ever called from `create()` — ama freezes the list after it.
 */
export function registerResources(
  api: HostApiWithResources,
  control: Control = callControl,
): boolean {
  if (!hasResources(api)) return false;
  try {
    api.resources.register({
      scheme: RESOURCE_SCHEME,
      describe: RESOURCE_DESCRIBE,
      read: (path, options) => readResource(path, options, control),
    });
    return true;
  } catch (error) {
    api.log("warn", "could not register the armadra resources", error);
    return false;
  }
}
