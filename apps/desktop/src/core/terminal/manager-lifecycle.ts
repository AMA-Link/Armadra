import type { DatabaseSync } from "node:sqlite";
import {
  type BackendKind,
  type SessionKey,
  type TerminalBackend,
  type TerminalSpec,
  conflict,
  notFound,
} from "./backend";
import type { TerminalDriveBook } from "./drive";
import { type EnvPairs, withUtf8Locale } from "./environment";
import { HIBERNATE_INTENT, rowHibernated } from "./hibernate";
import { InputSafety, type InputLedger } from "./input";
import type { SessionRecord, TerminalSession } from "./manager-types";
import type { ReviveOptions } from "./spawn-request";

/** 终端新建时的默认尺寸。 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * 会话换代、休眠、唤醒（从 manager.ts 拆出）要用的管理器内部件：管理器把自己的
 * 私有状态按这个形状递出来，函数体与拆出之前逐行相同。
 */
export interface LifecycleHost {
  readonly database: DatabaseSync;
  readonly effective: BackendKind;
  readonly inputs: InputLedger;
  readonly drives: TerminalDriveBook;
  readonly byKey: ReadonlyMap<SessionKey, string>;
  now(): string;
  clock(): number;
  backend(kind: BackendKind): TerminalBackend;
  require(sessionId: string): SessionRecord;
  withKey<T>(key: SessionKey, job: () => Promise<T>): Promise<T>;
  remember(record: SessionRecord): void;
  session(sessionId: string): TerminalSession;
  sessionEnvironment(
    env: EnvPairs,
    sessionId: string,
    generation: number,
  ): EnvPairs;
  isAlive(sessionId: string): boolean;
}

/**
 * Same `session_key`, next generation (contract §15.5). Sockets attached to
 * the old generation are told to clear and reconnect.
 */
export async function recycleSession(
  host: LifecycleHost,
  sessionId: string,
): Promise<TerminalSession> {
  const first = host.require(sessionId);
  return host.withKey(first.key, async () => {
    const record = host.require(sessionId);
    const nextGeneration = record.generation + 1;
    // The bump has to be visible *before* the old session is destroyed.
    // Destroying it ends the output stream every attached socket is reading,
    // and each of those sockets then asks what the current generation is:
    // still seeing the old one, they would close silently instead of sending
    // `stale`, and the client would treat a planned recycle as a dropped
    // connection. Marking it exited at the same time silences the exit its
    // own watcher is about to report.
    record.generation = nextGeneration;
    record.exited = true;
    try {
      await host.backend(record.kind).terminate(record.key, "session");
    } catch {
      // Already gone is the normal case for a session that exited by itself.
    }

    const kind = host.effective;
    const spec: TerminalSpec = {
      ...record.spec,
      generation: nextGeneration,
      env: host.sessionEnvironment(record.spec.env, sessionId, nextGeneration),
      size: { cols: record.cols, rows: record.rows },
    };
    let handle;
    try {
      handle = await host.backend(kind).create(spec);
    } catch (error) {
      // The old session is already gone, so the row must not keep claiming
      // to be running.
      host.database
        .prepare(
          `UPDATE terminal_sessions SET status = 'exited', attach_state = 'exited',
               ended_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(host.now(), sessionId);
      throw error;
    }

    host.database
      .prepare(
        `UPDATE terminal_sessions SET generation = ?, backend_kind = ?, backend_ref = ?,
             status = 'running', exit_code = NULL, ended_at = NULL,
             attach_state = 'detached', termination_intent = 'recycle',
             last_output_at = NULL WHERE id = ?`,
      )
      .run(handle.generation, kind, handle.backendRef ?? null, sessionId);

    // A recycled session is a new terminal in an old shell: the marks, the
    // half-typed line and what the previous process was doing all belong to
    // a pty that no longer exists.
    host.inputs.forget(sessionId);
    host.drives.forget(sessionId);
    host.remember({
      ...record,
      kind,
      generation: handle.generation,
      pid: handle.pid,
      exited: false,
      inputRevision: 0,
      inputSafety: new InputSafety(),
      lastActivity: undefined,
      startedAt: host.clock(),
      spec,
    });
    return host.session(sessionId);
  });
}

/* --------------------------- Eco 休眠的两个钩子 --------------------------- */

/**
 * 结束会话以释放内存，行记成休眠（终端宿主设计 §7.2）。判据不在这里——
 * `hibernator.ts` 判完才叫它；这里只保证「确认退出之后才写 hibernated」：
 * 后端 `terminate` 抛了，就当它还活着，记录原样退回去。
 */
export async function hibernateSession(
  host: LifecycleHost,
  sessionId: string,
): Promise<void> {
  const first = host.require(sessionId);
  return host.withKey(first.key, async () => {
    const record = host.require(sessionId);
    // 与 `terminate` 同一个次序：先标记，随之而来的退出是这一次结束，不是
    // 一次独立的退出，退出监视器不该把它记成 `exited` 并广播出去。
    record.exited = true;
    try {
      await host.backend(record.kind).terminate(record.key, "session");
    } catch (error) {
      record.exited = false;
      throw error;
    }
    host.database
      .prepare(
        `UPDATE terminal_sessions SET status = 'terminated', attach_state = 'exited',
             termination_intent = ?, ended_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(HIBERNATE_INTENT, host.now(), sessionId);
    host.inputs.forget(sessionId);
    host.drives.forget(sessionId);
  });
}

/**
 * 把一个休眠的会话在**同一个会话 id**上起回来，代次加一。
 *
 * 与 `recycle` 是同一种操作（同一个 `session_key`、下一个代次），区别只在起
 * 点：recycle 的旧进程还在，这里的早就没了，而且重启之后内存里连记录都没有，
 * 所以规格从行上重建。环境由调用方给——节点令牌与地址变量归装配层
 * （`install.ts` 的 `ownedEnvironment`），行上不存环境。
 *
 * 会话 id 不变是有意的：节点数据里记的就是它，页面照原样重新附着即可，不需要
 * 往画布里写一笔。同一个 key 上已经有别的活会话（有人在这期间起了新的），就
 * 拒绝——休眠已经被取代了，再起一个就是同一个节点上的第二个 CLI。
 */
export async function reviveSession(
  host: LifecycleHost,
  sessionId: string,
  env: EnvPairs,
  options: ReviveOptions = {},
): Promise<TerminalSession> {
  const row = host.database
    .prepare("SELECT * FROM terminal_sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound("Terminal session not found");
  const key = String(row.session_key) as SessionKey;
  return host.withKey(key, async () => {
    const current = host.database
      .prepare(
        "SELECT status, termination_intent, generation FROM terminal_sessions WHERE id = ?",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (current === undefined) throw notFound("Terminal session not found");
    // `ended`：驱动方式的切换与 ACP 会话的接回在同一行上起下一代，不需要
    // 休眠留下的那份承诺——行以什么方式结束的都行（ACP 设计 §4.2）。还在跑的
    // 行不在此列。
    const endedOk = options.ended === true && current.status !== "running";
    if (!rowHibernated(current) && !endedOk) {
      throw conflict("Terminal session is not hibernated");
    }
    const holder = host.byKey.get(key);
    if (holder !== undefined && holder !== sessionId && host.isAlive(holder)) {
      throw conflict("Another session is running for this node");
    }
    const nextGeneration = Number(current.generation ?? 0) + 1;
    const workspaceId = String(row.workspace_id);
    const command =
      options.command !== undefined
        ? (options.command ?? undefined)
        : ((row.command as string | null) ?? undefined);
    const spec: TerminalSpec = {
      sessionKey: key,
      workspaceId,
      generation: nextGeneration,
      cwd: options.cwd ?? String(row.cwd),
      shell: String(row.shell),
      ...(command === undefined ? {} : { command }),
      args: [],
      env: host.sessionEnvironment(
        withUtf8Locale(env),
        sessionId,
        nextGeneration,
      ),
      size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
      ...(options.sshHostId === undefined
        ? {}
        : { sshHostId: options.sshHostId }),
    };
    // 一个 ACP 行接回来仍是 ACP，终端行仍是终端；切换驱动时调用方点名。
    const kind: BackendKind =
      options.backend ?? (row.backend_kind === "acp" ? "acp" : host.effective);
    const handle = await host.backend(kind).create(spec);
    host.database
      .prepare(
        `UPDATE terminal_sessions SET generation = ?, backend_kind = ?, backend_ref = ?,
             command = ?, status = 'running', exit_code = NULL, ended_at = NULL,
             attach_state = 'detached', termination_intent = 'none',
             last_output_at = NULL WHERE id = ?`,
      )
      .run(
        handle.generation,
        kind,
        handle.backendRef ?? null,
        command ?? null,
        sessionId,
      );
    host.inputs.forget(sessionId);
    host.drives.forget(sessionId);
    host.remember({
      id: sessionId,
      key,
      workspaceId,
      ownerNodeId: (row.owner_node_id as string | null) ?? null,
      kind,
      generation: handle.generation,
      pid: handle.pid,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      exited: false,
      inputRevision: 0,
      inputSafety: new InputSafety(),
      lastActivity: undefined,
      startedAt: host.clock(),
      spec,
    });
    return host.session(sessionId);
  });
}
