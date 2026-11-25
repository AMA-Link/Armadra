import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  STATE_SOURCE_TRANSCRIPT,
  markChannelUnbound,
} from "../../agent/state-source";
import {
  type StateSlot,
  type StateSlotContext,
  type StateSlotProvider,
} from "../../timeline/sources/state-slot";
import {
  type AgentEvent,
  DONE,
  WAITING,
  WORKING,
  sessionEvent,
  stateEvent,
} from "../normalize/event";

/**
 * Grok Build's status source (contract §121): core reads the CLI's own record of
 * the process the node's terminal is running. No hook, no extension, nothing
 * written to `~/.grok`.
 *
 *   * **Binding by process.** `$GROK_HOME/active_sessions.json` lists
 *     `{ session_id, pid, pid_start, cwd, opened_at }` for every session a running
 *     grok has open, kept live and cleared on exit. The rows whose `pid` is the
 *     node's PTY process or one of its descendants are *this node's*. `/new`,
 *     `/resume`, `/fork` and `/home` open another session in the **same** process
 *     (the old row stays), so a node can have several rows; every one is tailed
 *     and the answers aggregated: any row waiting on an approval is `waiting`,
 *     else any row in a turn is `working`, else `done`. A pre-minted `-s <id>`
 *     would have followed the first session only, and left the node reporting
 *     `done` while the TUI sat on a permission prompt after `/new`.
 *   * **Reading.** Each row's `sessions/<cwd, percent-encoded>/<id>/events.jsonl`
 *     (flushed as it happens — a pending approval is in the file while the prompt
 *     is still on screen) is read from where it left off; a row seen for the
 *     first time is replayed (the tail, at most 2 MiB) so a core restart recovers
 *     the state. `readNow` is synchronous, and `send` calls it before it judges a
 *     node idle: the poll interval alone is a window in which the file already
 *     says `working` and the row still says `done`.
 *   * **Auto-allow.** A `--allow` rule answers within tens of milliseconds
 *     (`permission_requested`, then `permission_resolved allow` 34 ms later, measured
 *     on 1.0.92 with a real account), so a request is `waiting` only once it has
 *     been open for {@link PERMISSION_GRACE_MS}.
 *   * **Fallback.** No row for the node's processes (grok not started yet, started
 *     by something else, a leader) reports nothing — the node stays where it was.
 *     A file that exists but cannot be parsed marks the node's channel *unbound*
 *     (`markChannelUnbound`), and the gate then takes the observed path.
 */

/** How long a permission request must stay open before it counts as waiting. */
export const PERMISSION_GRACE_MS = 300;
const POLL_MS = 1_000;
const REPLAY_BYTES = 2 * 1024 * 1024;

export interface ActiveRow {
  readonly sessionId: string;
  readonly pid: number;
  readonly cwd: string;
}

export type ActiveRead =
  | { readonly kind: "rows"; readonly rows: readonly ActiveRow[] }
  /** No file yet: nothing has ever run grok under this home. Not an error. */
  | { readonly kind: "absent" }
  /** The file is there and unreadable, or not the shape this reader knows. */
  | { readonly kind: "unreadable" };

export interface GrokDeps {
  /** `$GROK_HOME` or `~/.grok`. */
  home(): string;
  readActive(home: string): ActiveRead;
  /** pid → parent pid for every process; `undefined` when it cannot be read. */
  processTable(): ReadonlyMap<number, number> | undefined;
  /** Where `events.jsonl` of this row is, or `undefined`. */
  locate(home: string, row: ActiveRow): string | undefined;
  now(): number;
}

/* ------------------------------ real readers ------------------------------ */

export function grokHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GROK_HOME;
  return home !== undefined && home !== "" ? home : join(homedir(), ".grok");
}

export function readActiveSessions(home: string): ActiveRead {
  const path = join(home, "active_sessions.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  const list =
    Array.isArray(value) &&
    value.every((row) => typeof row === "object" && row !== null)
      ? (value as Record<string, unknown>[])
      : undefined;
  if (list === undefined) return { kind: "unreadable" };
  const rows: ActiveRow[] = [];
  for (const row of list) {
    const { session_id: sessionId, pid, cwd } = row;
    if (
      typeof sessionId !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      typeof cwd !== "string"
    ) {
      return { kind: "unreadable" };
    }
    rows.push({ sessionId, pid, cwd });
  }
  return { kind: "rows", rows };
}

export function psProcessTable(): ReadonlyMap<number, number> | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string")
    return undefined;
  const table = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

/** `/` → `%2F` and the rest of `encodeURIComponent`'s alphabet, as grok names the group. */
export function encodeCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

export function locateEvents(home: string, row: ActiveRow): string | undefined {
  const sessions = join(home, "sessions");
  const direct = join(
    sessions,
    encodeCwd(row.cwd),
    row.sessionId,
    "events.jsonl",
  );
  if (existsSync(direct)) return direct;
  // A long cwd is named by a slug and a hash (a `.cwd` file inside says which),
  // and an alias (a symlinked cwd) encodes differently: one level of directories
  // is cheap to look through.
  try {
    for (const group of readdirSync(sessions)) {
      const candidate = join(sessions, group, row.sessionId, "events.jsonl");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const realGrokDeps: GrokDeps = {
  home: () => grokHome(),
  readActive: readActiveSessions,
  processTable: psProcessTable,
  locate: locateEvents,
  now: () => Date.now(),
};

/* ------------------------------- one session ------------------------------- */

type TailState = "idle" | "working" | "waiting";

/** What reading a session's file says right now. */
export interface TailView {
  readonly state: TailState;
  /** Turns begun so far (a rising number means a new turn started). */
  readonly turns: number;
  /** How the last turn ended; `undefined` while in a turn or before any. */
  readonly ended?: "completed" | "cancelled" | "error";
  /** When the open permission request began, in epoch ms. */
  readonly requestedAt?: number;
}

/**
 * The per-session state machine over `events.jsonl` lines. Pure: feed it parsed
 * lines in order. Unknown lines are counted, not an error (the format is alpha);
 * an `outcome` it does not know ends the turn as `error`.
 */
export class SessionTail {
  private inTurn = false;
  private turns = 0;
  private ended: TailView["ended"];
  private requestedAt: number | undefined;
  unknownLines = 0;

  apply(record: unknown): void {
    if (typeof record !== "object" || record === null) {
      this.unknownLines += 1;
      return;
    }
    const line = record as Record<string, unknown>;
    switch (line.type) {
      case "turn_started":
        this.inTurn = true;
        this.turns += 1;
        this.ended = undefined;
        this.requestedAt = undefined;
        break;
      case "permission_requested": {
        const at = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
        this.requestedAt = Number.isFinite(at) ? at : 0;
        this.inTurn = true;
        break;
      }
      case "permission_resolved":
        this.requestedAt = undefined;
        break;
      case "turn_ended": {
        this.inTurn = false;
        this.requestedAt = undefined;
        const outcome = line.outcome;
        this.ended =
          outcome === "completed" || outcome === "cancelled"
            ? outcome
            : "error";
        break;
      }
      case "tool_started":
      case "tool_completed":
      case "loop_started":
      case "first_token":
      case "phase_changed":
        break;
      default:
        // `mcp_*` and whatever a newer grok adds: not a state.
        if (typeof line.type !== "string") this.unknownLines += 1;
    }
  }

  view(nowMs: number): TailView {
    if (this.requestedAt !== undefined) {
      return {
        state:
          nowMs - this.requestedAt >= PERMISSION_GRACE_MS
            ? "waiting"
            : "working",
        turns: this.turns,
        requestedAt: this.requestedAt,
      };
    }
    return {
      state: this.inTurn ? "working" : "idle",
      turns: this.turns,
      ...(this.ended === undefined ? {} : { ended: this.ended }),
    };
  }
}

/** Waiting beats working beats done; the latest ended turn's verdict rides along. */
export function aggregate(views: readonly TailView[]): {
  state: "waiting" | "working" | "done";
  turns: number;
  ended?: TailView["ended"];
} {
  const turns = views.reduce((sum, view) => sum + view.turns, 0);
  if (views.some((view) => view.state === "waiting")) {
    return { state: "waiting", turns };
  }
  if (views.some((view) => view.state === "working")) {
    return { state: "working", turns };
  }
  const ended = [...views]
    .reverse()
    .find((view) => view.ended !== undefined)?.ended;
  return { state: "done", turns, ...(ended === undefined ? {} : { ended }) };
}

/* ---------------------------------- slot ---------------------------------- */

interface Followed {
  readonly row: ActiveRow;
  readonly tail: SessionTail;
  path: string | undefined;
  offset: number;
  partial: string;
}

class GrokSlot implements StateSlot {
  private readonly followed = new Map<string, Followed>();
  private timer: unknown;
  private graceTimer: unknown;
  private stopped = false;
  /** What was last reported: `${state}`, and the turns total it was reported at. */
  private last: { state: string; turns: number } | undefined;
  private announced = new Set<string>();

  constructor(
    private readonly context: StateSlotContext,
    private readonly deps: GrokDeps,
  ) {}

  start(): void {
    this.readNow();
    this.arm();
  }

  poke(): void {
    this.readNow();
  }

  /** Synchronous: bind, read what was appended, report a change. */
  readNow(): void {
    if (this.stopped) return;
    const home = this.deps.home();
    const active = this.deps.readActive(home);
    markChannelUnbound(this.context.nodeId, active.kind === "unreadable");
    if (active.kind !== "rows") return;
    const bound = this.bind(active.rows);
    for (const row of bound) {
      let followed = this.followed.get(row.sessionId);
      if (followed === undefined) {
        followed = {
          row,
          tail: new SessionTail(),
          path: undefined,
          offset: -1,
          partial: "",
        };
        this.followed.set(row.sessionId, followed);
      }
      this.read(followed, home);
    }
    this.report(bound.map((row) => row.sessionId));
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
    markChannelUnbound(this.context.nodeId, false);
  }

  /* ------------------------------- internals ------------------------------- */

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.context.timers.setTimeout(() => {
      this.timer = undefined;
      try {
        this.readNow();
      } catch (error) {
        this.context.log.warn("reading grok's session record failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.arm();
    }, POLL_MS);
  }

  private cancel(): void {
    if (this.timer !== undefined) this.context.timers.clearTimeout(this.timer);
    if (this.graceTimer !== undefined) {
      this.context.timers.clearTimeout(this.graceTimer);
    }
    this.timer = undefined;
    this.graceTimer = undefined;
  }

  /** The rows that belong to this node: its PTY process or a descendant of it. */
  private bind(rows: readonly ActiveRow[]): ActiveRow[] {
    const root = this.context.pid();
    if (root === undefined) return [];
    const mine = rows.filter((row) => row.pid === root);
    const others = rows.filter((row) => row.pid !== root);
    if (others.length === 0) return mine;
    const table = this.deps.processTable();
    if (table === undefined) return mine;
    for (const row of others) {
      let at: number | undefined = row.pid;
      for (let depth = 0; at !== undefined && depth < 64; depth += 1) {
        if (at === root) {
          mine.push(row);
          break;
        }
        at = table.get(at);
        if (at === 0 || at === 1) break;
      }
    }
    return mine;
  }

  private read(followed: Followed, home: string): void {
    followed.path ??= this.deps.locate(home, followed.row);
    if (followed.path === undefined) return;
    let fd: number;
    try {
      fd = openSync(followed.path, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (followed.offset < 0) {
        // First sight: replay the tail so the state is whatever the file says.
        followed.offset = Math.max(0, size - REPLAY_BYTES);
        if (followed.offset > 0) followed.partial = "\u0000skip";
      }
      if (size < followed.offset) {
        // Truncated or replaced: start over.
        followed.offset = 0;
        followed.partial = "";
      }
      if (size === followed.offset) return;
      const buffer = Buffer.alloc(size - followed.offset);
      const read = readSync(fd, buffer, 0, buffer.length, followed.offset);
      followed.offset += read;
      const text = followed.partial + buffer.subarray(0, read).toString("utf8");
      const lines = text.split("\n");
      const skipFirst = followed.partial === "\u0000skip";
      followed.partial = lines.pop() ?? "";
      lines.forEach((line, index) => {
        if (skipFirst && index === 0) return;
        if (line === "") return;
        try {
          followed.tail.apply(JSON.parse(line.replace(/^\u0000skip/, "")));
        } catch {
          followed.tail.unknownLines += 1;
        }
      });
    } finally {
      closeSync(fd);
    }
  }

  private report(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const nowMs = this.deps.now();
    const views = ids.flatMap((id) => {
      const followed = this.followed.get(id);
      return followed === undefined ? [] : [followed.tail.view(nowMs)];
    });
    if (views.length === 0) return;
    // A new row is a new session in this process: say so once (`/new`, or the
    // first one the node's grok opened), so the first idle is the session's own.
    for (const id of ids) {
      if (this.announced.has(id)) continue;
      this.announced.add(id);
      this.send(
        sessionEvent(this.context.nodeId, this.context.agentId, "start"),
        id,
      );
    }
    const next = aggregate(views);
    this.scheduleGrace(views);
    // 一个还没有任何回合的会话没有「完成」可说：只有上面的 session start，状态留空
    // （与 Claude 起来之后的样子一致，首投放行门认的就是「开场之后还没有状态」）。
    if (next.turns === 0 && next.state === "done") return;
    const key = next.state;
    const before = this.last;
    if (
      before !== undefined &&
      before.state === key &&
      before.turns === next.turns
    ) {
      return;
    }
    const freshTurn = before === undefined || next.turns > before.turns;
    this.last = { state: key, turns: next.turns };
    const event: AgentEvent =
      next.state === "waiting"
        ? stateEvent(this.context.nodeId, this.context.agentId, WAITING)
        : next.state === "working"
          ? stateEvent(this.context.nodeId, this.context.agentId, WORKING)
          : stateEvent(this.context.nodeId, this.context.agentId, DONE);
    if (next.state === "working" && freshTurn) event.newTurn = true;
    if (next.state === "done") {
      if (next.ended === "error") event.errored = true;
      if (next.ended === "cancelled") event.interrupted = true;
    }
    this.send(event);
  }

  /** A request inside its grace window is re-judged when the window closes. */
  private scheduleGrace(views: readonly TailView[]): void {
    if (this.graceTimer !== undefined) return;
    const open = views.filter(
      (view) => view.state === "working" && view.requestedAt !== undefined,
    );
    if (open.length === 0) return;
    this.graceTimer = this.context.timers.setTimeout(() => {
      this.graceTimer = undefined;
      try {
        this.readNow();
      } catch {
        // the next poll tries again
      }
    }, PERMISSION_GRACE_MS + 10);
  }

  private send(event: AgentEvent, sessionId?: string): void {
    event.stateSource = STATE_SOURCE_TRANSCRIPT;
    if (sessionId !== undefined) event.sessionId = sessionId;
    this.context.report(event);
  }
}

/** The slot provider core registers (`registerStateSlot`). */
export function grokSlotProvider(
  deps: GrokDeps = realGrokDeps,
): StateSlotProvider {
  return {
    agentId: "grok",
    level: "reported",
    open(context) {
      // Another machine's files are not readable here; Windows has no
      // `active_sessions.json` to speak of (nor `ps`).
      if (context.remote() || process.platform === "win32") return undefined;
      return new GrokSlot(context, deps);
    },
  };
}
