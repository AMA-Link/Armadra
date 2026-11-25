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
import { basename, join } from "node:path";

import {
  STATE_SOURCE_TRANSCRIPT,
  markChannelUnbound,
} from "../../agent/state-source";
import { SCREEN_SIGNATURES } from "../../agent/screen-gate";
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

/** Every process's parent and executable name, from one `ps` snapshot. */
export interface ProcessTable {
  readonly parents: ReadonlyMap<number, number>;
  readonly names: ReadonlyMap<number, string>;
}

export interface GrokDeps {
  /** `$GROK_HOME` of the node's own session environment, else core's, else `~/.grok`. */
  home(sessionHome?: string): string;
  readActive(home: string): ActiveRead;
  /** The process table; `undefined` when it cannot be read. */
  processTable(): ProcessTable | undefined;
  /** Where this runs: the gate and the slot both read it from here, never from `process`. */
  platform(): NodeJS.Platform;
  /** Where `events.jsonl` of this row is, or `undefined`. */
  locate(home: string, row: ActiveRow): string | undefined;
  now(): number;
}

/* ------------------------------ real readers ------------------------------ */

export function grokHome(
  env: NodeJS.ProcessEnv = process.env,
  sessionHome?: string,
): string {
  if (sessionHome !== undefined && sessionHome !== "") return sessionHome;
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

/** One `ps -A` serves every slot for this long (many nodes poll once a second). */
const PROCESS_TABLE_TTL_MS = 1_000;
let cachedTable: { at: number; table: ProcessTable | undefined } | undefined;

export function psProcessTable(
  now: () => number = Date.now,
): ProcessTable | undefined {
  if (process.platform === "win32") return undefined;
  const at = now();
  if (cachedTable !== undefined && at - cachedTable.at < PROCESS_TABLE_TTL_MS) {
    return cachedTable.table;
  }
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,comm="], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let table: ProcessTable | undefined;
  if (result.status === 0 && typeof result.stdout === "string") {
    const parents = new Map<number, number>();
    const names = new Map<number, string>();
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
      if (match === null) continue;
      parents.set(Number(match[1]), Number(match[2]));
      names.set(Number(match[1]), basename(match[3] ?? ""));
    }
    table = { parents, names };
  }
  cachedTable = { at, table };
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
  home: (sessionHome) => grokHome(process.env, sessionHome),
  readActive: readActiveSessions,
  processTable: () => psProcessTable(),
  platform: () => process.platform,
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
  /** When the last turn ended (epoch ms); `0` when the line carries no time. */
  readonly endedAt?: number;
  /** The tool the turn is parked on until a person answers (`exit_plan_mode`). */
  readonly asking?: string;
}

/**
 * Tools that hold the turn open on a person: grok does not end the turn while
 * the plan review (`a approve | s request changes | …`) or a question card
 * (`1 (○) Red …`) is up. Both are auto-resolved at the permission layer
 * (`permission_resolved allow wait_ms 0`), so only the tool names say it
 * (1.0.92, real account). A dismissed card ends the turn `cancelled` with no
 * `tool_completed`.
 */
const ASKING_TOOLS = new Set(["exit_plan_mode", "ask_user_question"]);

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
  private endedAt = 0;
  private asking: string | undefined;
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
        this.asking = undefined;
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
        this.asking = undefined;
        {
          const at = typeof line.ts === "string" ? Date.parse(line.ts) : NaN;
          this.endedAt = Number.isFinite(at) ? at : 0;
        }
        const outcome = line.outcome;
        this.ended =
          outcome === "completed" || outcome === "cancelled"
            ? outcome
            : "error";
        break;
      }
      case "tool_started": {
        // Lines that only happen inside a turn also say "in a turn": a replay
        // window cut in the middle of one never saw its `turn_started`.
        this.inTurn = true;
        const tool = line.tool_name;
        if (typeof tool === "string" && ASKING_TOOLS.has(tool)) {
          this.asking = tool;
        }
        break;
      }
      case "tool_completed": {
        const tool = line.tool_name;
        if (
          this.asking !== undefined &&
          (typeof tool !== "string" || tool === this.asking)
        ) {
          this.asking = undefined;
        }
        break;
      }
      case "loop_started":
        // A new model loop after the review tool: the review was answered (quit
        // plan / approve) — measured on 1.0.92, no `tool_completed` follows it.
        this.asking = undefined;
        this.inTurn = true;
        break;
      case "first_token":
      case "phase_changed":
        this.inTurn = true;
        break;
      default:
        // `mcp_*` and whatever a newer grok adds: not a state.
        if (typeof line.type !== "string") this.unknownLines += 1;
    }
  }

  view(nowMs: number): TailView {
    if (this.asking !== undefined && this.inTurn) {
      return {
        state: "waiting",
        turns: this.turns,
        asking: this.asking,
      };
    }
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
      ...(this.ended === undefined
        ? {}
        : { ended: this.ended, endedAt: this.endedAt }),
    };
  }
}

/** Waiting beats working beats done; the latest ended turn's verdict rides along. */
export function aggregate(views: readonly TailView[]): {
  state: "waiting" | "working" | "done";
  turns: number;
  ended?: TailView["ended"];
  asking?: string;
} {
  const turns = views.reduce((sum, view) => sum + view.turns, 0);
  const waiting = views.filter((view) => view.state === "waiting");
  if (waiting.length > 0) {
    const asking = waiting.find((view) => view.asking !== undefined)?.asking;
    return {
      state: "waiting",
      turns,
      ...(asking === undefined ? {} : { asking }),
    };
  }
  if (views.some((view) => view.state === "working")) {
    return { state: "working", turns };
  }
  // The one that ended last, not the last in row order.
  let latest: TailView | undefined;
  for (const view of views) {
    if (view.ended === undefined) continue;
    if (latest === undefined || (view.endedAt ?? 0) >= (latest.endedAt ?? 0)) {
      latest = view;
    }
  }
  const ended = latest?.ended;
  return { state: "done", turns, ...(ended === undefined ? {} : { ended }) };
}

/* ---------------------------------- slot ---------------------------------- */

/** No row of this node for this long, with grok running in it: the channel is unbound. */
export const UNBOUND_AFTER_MS = 15_000;

interface Followed {
  readonly row: ActiveRow;
  tail: SessionTail;
  path: string | undefined;
  offset: number;
  partial: string;
}

class GrokSlot implements StateSlot {
  private readonly followed = new Map<string, Followed>();
  private timer: unknown;
  private graceTimer: unknown;
  private stopped = false;
  /** What was last reported: the state, and each session's turn count then. */
  private last: { state: string; turns: string; asking: boolean } | undefined;
  private announced = new Set<string>();
  /** Turns seen per session, to tell "a session began a turn" from "the sum moved". */
  private readonly seenTurns = new Map<string, number>();
  private hadBound = false;
  private unreadable = false;
  private noRowSince: number | undefined;
  private noRowUnbound = false;
  private screenCheck = false;

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
    // The node's own `GROK_HOME` (a node environment can differ from core's).
    const home = this.deps.home(this.context.env?.("GROK_HOME"));
    const active = this.deps.readActive(home);
    this.unreadable = active.kind === "unreadable";
    const bound = active.kind === "rows" ? this.bind(active.rows) : [];
    this.judgeBinding(bound.length > 0);
    if (active.kind !== "rows") return;
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

  /**
   * The channel is unbound when the file is unreadable, or when grok has been
   * running in this node's process tree for {@link UNBOUND_AFTER_MS} without a
   * row of this node showing up (a leader, a `GROK_HOME` core cannot see, a
   * wrapper that left the tree) and the screen is not the trust dialog (no row
   * exists until it is answered). A row appearing undoes it.
   */
  private judgeBinding(hasRow: boolean): void {
    if (hasRow) {
      this.noRowSince = undefined;
      this.noRowUnbound = false;
    } else if (this.runsGrok()) {
      const now = this.deps.now();
      this.noRowSince ??= now;
      if (
        !this.noRowUnbound &&
        !this.screenCheck &&
        now - this.noRowSince >= UNBOUND_AFTER_MS
      ) {
        this.confirmUnbound();
      }
    } else {
      this.noRowSince = undefined;
      this.noRowUnbound = false;
    }
    markChannelUnbound(
      this.context.nodeId,
      this.unreadable || this.noRowUnbound,
    );
  }

  private runsGrok(): boolean {
    const root = this.context.pid();
    if (root === undefined) return false;
    const table = this.deps.processTable();
    if (table === undefined) return false;
    for (const [pid, name] of table.names) {
      if (name !== "grok") continue;
      let at: number | undefined = pid;
      for (let depth = 0; at !== undefined && depth < 64; depth += 1) {
        if (at === root) return true;
        at = table.parents.get(at);
        if (at === 0 || at === 1) break;
      }
    }
    return false;
  }

  private confirmUnbound(): void {
    const capture = this.context.screen;
    const decide = (screen: string | undefined) => {
      this.screenCheck = false;
      if (this.stopped || this.noRowSince === undefined) return;
      const trust = SCREEN_SIGNATURES.grok?.dialogs.find(
        (dialog) => dialog.id === "grok.folder-trust",
      );
      const onTrustDialog =
        screen !== undefined &&
        trust !== undefined &&
        screen.split("\n").some((line) => trust.pattern.test(line));
      if (onTrustDialog) {
        this.noRowSince = this.deps.now();
        return;
      }
      this.noRowUnbound = true;
      markChannelUnbound(this.context.nodeId, true);
    };
    if (capture === undefined) {
      decide(undefined);
      return;
    }
    this.screenCheck = true;
    void capture().then(decide, () => decide(undefined));
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
    const parents = table.parents;
    for (const row of others) {
      let at: number | undefined = row.pid;
      for (let depth = 0; at !== undefined && depth < 64; depth += 1) {
        if (at === root) {
          mine.push(row);
          break;
        }
        at = parents.get(at);
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
        followed.tail = new SessionTail();
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
    if (ids.length === 0) {
      // The node's grok exited (or every row went): the session is over, and a
      // later one starts from nothing — no stale state to dedupe against.
      if (this.hadBound) {
        this.hadBound = false;
        this.send(
          sessionEvent(this.context.nodeId, this.context.agentId, "end"),
        );
        this.last = undefined;
        this.announced.clear();
        this.followed.clear();
        this.seenTurns.clear();
      }
      return;
    }
    this.hadBound = true;
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
    const turnsOf = (id: string) =>
      this.followed.get(id)?.tail.view(nowMs).turns ?? 0;
    const turnsKey = ids.map((id) => `${id}:${turnsOf(id)}`).join(",");
    const asking = next.asking !== undefined;
    if (
      before !== undefined &&
      before.state === key &&
      before.turns === turnsKey &&
      before.asking === asking
    ) {
      return;
    }
    // A fresh turn is one session's count rising, not the sum moving (a session
    // closing lowers the sum, a new one raises it from nothing).
    let freshTurn = before === undefined;
    for (const id of ids) {
      const turns = turnsOf(id);
      if (turns > (this.seenTurns.get(id) ?? 0)) freshTurn = true;
      this.seenTurns.set(id, turns);
    }
    this.last = { state: key, turns: turnsKey, asking };
    const event: AgentEvent =
      next.state === "waiting"
        ? stateEvent(this.context.nodeId, this.context.agentId, WAITING)
        : next.state === "working"
          ? stateEvent(this.context.nodeId, this.context.agentId, WORKING)
          : stateEvent(this.context.nodeId, this.context.agentId, DONE);
    if (next.state === "working" && freshTurn) event.newTurn = true;
    // The plan review holds the turn open on a person: say what is asked, and
    // close the question when it is answered (or the turn ends).
    if (next.state === "waiting" && next.asking !== undefined) {
      event.awaitingInput = true;
      event.askKind = next.asking;
    } else if (before?.asking === true) {
      event.questionClosed = true;
    }
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
      if (context.remote() || deps.platform() === "win32") return undefined;
      return new GrokSlot(context, deps);
    },
  };
}
