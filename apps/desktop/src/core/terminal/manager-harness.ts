import type { DatabaseSync } from "node:sqlite";
import {
  type AdoptableBackend,
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type AttachOptions,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type ProgramTap,
  type SessionKey,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  conflict,
  notFound,
  sessionName,
} from "./backend";
import { TerminalManager } from "./manager";
import type { Lease } from "../drive/lease";
import { fixture, type Fixture } from "../workspaces/fixture";

/**
 * The manager's own decisions, on a fake backend and a clock the test owns.
 *
 * Everything here is about *bookkeeping*: which row moves, which generation
 * wins, what a sweep is allowed to touch, when a session falls asleep. None of
 * it needs a PTY, and giving it one would make a suite about database rows
 * take twenty seconds and depend on the machine's load.
 */

interface FakeSession {
  generation: number;
  dormant: boolean;
  destroyed: boolean;
}

export class FakeBackend implements AdoptableBackend {
  readonly kind: BackendKind = "tmux";
  readonly sessions = new Map<SessionKey, FakeSession>();
  readonly calls: string[] = [];
  /** What each `attach` was told about its viewer (#565). */
  readonly attachOptions: (AttachOptions | undefined)[] = [];
  /** Window and per-viewer resizes, apart from `calls` so no other test moves. */
  readonly sizes: string[] = [];
  private readonly sinks: ((notice: BackendNotice) => void)[] = [];
  private nextId = 1;
  /** Set to make the next `create` fail, as a recycle onto a dead shell would. */
  failCreate = false;

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    this.calls.push(`create:${spec.sessionKey}:${spec.generation}`);
    if (this.failCreate) throw notFound("no backend");
    this.sessions.set(spec.sessionKey, {
      generation: spec.generation,
      dormant: false,
      destroyed: false,
    });
    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      backendRef: sessionName(
        spec.workspaceId,
        spec.sessionKey,
        spec.generation,
      ),
      pid: 1234,
    };
  }

  async adopt(key: SessionKey, _reference: string, generation: number) {
    this.sessions.set(key, { generation, dormant: false, destroyed: false });
    return 4321;
  }

  async attach(
    key: SessionKey,
    generation: number,
    _size: TerminalSize,
    options?: AttachOptions,
  ): Promise<Attachment> {
    this.attachOptions.push(options);
    const session = this.sessions.get(key);
    if (session === undefined) throw notFound("gone");
    if (session.generation !== generation) throw conflict("stale");
    return {
      attachmentId: this.nextId++,
      generation: session.generation,
      onData: () => {},
      onExit: () => {},
    };
  }

  async detach(): Promise<void> {}

  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    this.calls.push(`input:${key}:${bytes.toString("utf8")}`);
  }

  async reply(
    key: SessionKey,
    attachmentId: number,
    bytes: Buffer,
  ): Promise<void> {
    this.calls.push(
      `reply${attachmentId}:${key}:${JSON.stringify(bytes.toString("utf8"))}`,
    );
  }

  async paste(key: SessionKey, text: string, enter: boolean): Promise<void> {
    this.calls.push(`paste:${key}:${text}:${String(enter)}`);
  }

  async resize(_key: SessionKey, size: TerminalSize): Promise<void> {
    this.sizes.push(`window:${size.cols}x${size.rows}`);
  }

  async resizeViewer(
    _key: SessionKey,
    attachmentId: number,
    size: TerminalSize,
  ): Promise<void> {
    this.sizes.push(`viewer${attachmentId}:${size.cols}x${size.rows}`);
  }

  async capture(): Promise<string> {
    return "line one\nline two";
  }

  async signal(key: SessionKey): Promise<void> {
    this.calls.push(`signal:${key}`);
  }

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    this.calls.push(`terminate:${key}:${mode}`);
    if (mode === "session") this.sessions.delete(key);
  }

  async getForeground(): Promise<ForegroundInfo> {
    return { pid: 1234, command: "claude", children: [] };
  }

  getCapabilities(): BackendCapabilities {
    return {
      kind: "tmux",
      persistent: true,
      redrawsOnAttach: true,
      usable: true,
    };
  }

  async list(): Promise<BackendRef[]> {
    return [...this.sessions.entries()].map(([key, session]) => ({
      name: sessionName("ws", key, session.generation),
      attached: false,
    }));
  }

  async destroyByReference(reference: string): Promise<void> {
    this.calls.push(`destroyRef:${reference}`);
  }

  async scroll(key: SessionKey, lines: number): Promise<void> {
    this.calls.push(`scroll:${key}:${lines}`);
  }

  async setDormant(key: SessionKey, dormant: boolean): Promise<void> {
    const session = this.sessions.get(key);
    if (session === undefined) throw notFound("gone");
    session.dormant = dormant;
    this.calls.push(`dormant:${key}:${String(dormant)}`);
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.sinks.push(listener);
  }

  /** Reports a session that ended with nothing attached to it. */
  announce(notice: BackendNotice): void {
    for (const sink of this.sinks) sink(notice);
  }

  async reapAll(): Promise<void> {
    this.calls.push("reapAll");
  }

  async detachAll(): Promise<void> {
    this.calls.push("detachAll");
  }

  private readonly programListeners: ((
    key: SessionKey,
    generation: number,
    chunk: Buffer,
  ) => void)[] = [];

  readonly programTap: ProgramTap = {
    subscribe: (listener) => {
      this.programListeners.push(listener);
    },
    answer: async (key, bytes) => {
      this.calls.push(
        `answer:${key}:${JSON.stringify(bytes.toString("utf8"))}`,
      );
    },
  };

  /** What the program wrote, as the tap would hand it over. */
  print(key: string, generation: number, text: string): void {
    for (const listener of this.programListeners)
      listener(key as SessionKey, generation, Buffer.from(text, "latin1"));
  }
}

let open: Fixture | undefined;

/** Closes the fixture of the last `harness()`; call it from `afterEach`. */
export function closeHarness(): void {
  open?.close();
  open = undefined;
}

export interface Harness {
  manager: TerminalManager;
  backend: FakeBackend;
  database: DatabaseSync;
  advance: (ms: number) => void;
  /** 每一次租约换手，按发生顺序。 */
  leases: LeaseEvent[];
  /** 契约 §53 的每一帧。 */
  programs: { sessionId: string; nodeId: string | null; state?: string }[];
}

export interface LeaseEvent {
  sessionId: string;
  nodeId: string | null;
  lease: Lease;
}

export function harness(
  policy?: {
    detachedGraceMinutes: number;
    dormantAfterSeconds: number;
  },
  options: {
    singlePty?: boolean;
    limits?: { terminalsPerPrincipal: number; agentsPerWorkspace: number };
  } = {},
): Harness {
  open = fixture([]);
  const database = open.database;
  database
    .prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
         VALUES ('ws', 'Canvas', ?, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`,
    )
    .run(`${open.directory}/ws`);
  let now = Date.parse("2026-09-20T12:00:00.000Z");
  const backend = new FakeBackend();
  // direct / session-host：只有一个 pty，没有每端自己的视图。
  if (options.singlePty === true) {
    Object.defineProperty(backend, "resizeViewer", { value: undefined });
    Object.defineProperty(backend, "reply", { value: undefined });
  }
  const leases: LeaseEvent[] = [];
  const programs: Harness["programs"] = [];
  const manager = new TerminalManager({
    database,
    backends: new Map([["tmux", backend]]),
    effective: "tmux",
    ...(options.limits === undefined ? {} : { limits: () => options.limits! }),
    onProgramStatus: (event) => {
      programs.push({
        sessionId: event.sessionId,
        nodeId: event.nodeId,
        ...(event.status === undefined ? {} : { state: event.status.state }),
      });
    },
    onLease: (event) => {
      leases.push({
        sessionId: event.sessionId,
        nodeId: event.nodeId,
        lease: event.lease,
      });
    },
    policy: () =>
      policy ?? { detachedGraceMinutes: 1440, dormantAfterSeconds: 120 },
    now: () => new Date(now).toISOString(),
    clock: () => now,
  });
  return {
    manager,
    backend,
    database,
    leases,
    programs,
    advance: (ms) => {
      now += ms;
    },
  };
}

export const spawn = (manager: TerminalManager, nodeId?: string) =>
  manager.spawn({
    workspaceId: "ws",
    cwd: "/tmp",
    command: "/bin/sh",
    ...(nodeId === undefined ? {} : { ownerNodeId: nodeId }),
  });
