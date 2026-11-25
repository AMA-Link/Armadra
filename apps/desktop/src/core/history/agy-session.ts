import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { type ProcessTable, psProcessTable } from "../hook/sources/grok-events";
import { classifyConversations, roots } from "./agy";

/**
 * 终端里的 agy 没有 hook，怎么知道它此刻在哪个会话里（#1036，观察级，不进任何门）。
 *
 * 实测事实（agy 1.5.16 / 1.5.17，只读本机文件，没有发模型请求）：每个 agy **进程**
 * 自己持有一个日志文件 `~/.gemini/antigravity-cli/log/cli-<启动时刻>.log`（`lsof -p
 * <pid>` 能看到它被这个进程打开）。日志里有这几种行（glog 前缀 + 源文件:行号）：
 *
 *     I1124 21:23:48.548734  630 server.go:1269] Created conversation <id> (backend=…)
 *     I1124 21:23:48.549753  630 conversation_manager.go:1282] Streaming conversation <id>
 *     I1124 21:23:49.522165  630 server.go:1883] Sending user message to conversation <id> (items=…)
 *
 * 用四个已有的测试会话逐个对过：每个会话 id 恰好出现在创建它的那个进程的日志里，
 * 一一对应。所以
 *
 *     节点的终端进程 → 它的后代里的 agy 进程 → 它持有的 cli-*.log → 会话 id
 *
 * 是没有歧义的映射，不依赖 cwd，也不依赖 hook。
 *
 * 当前会话（保守）：日志里最后一条 `Sending user message to conversation` 或
 * `Streaming conversation`（接回的会话没有 `Created`，`/new` 之后当前的是最近说话的
 * 那个），都没有时退回最后一条 `Created conversation`。每个候选都要过索引库：只认
 * 确认是顶层（无父会话、深度 0）的；子代理（库里有、不是顶层）永久不认，库里还没有
 * 的稍后再问。索引读不了时，只有整份日志里恰好一个会话 id 才用。子代理是否也写这些
 * 行，没有真账号的子代理回合没法确认（见 #1036），所以靠索引库的父会话信息兜底。
 *
 * 成本：稳态下每次只有一次共享的 `ps` 加一次 `stat`。日志路径按 pid 缓存，日志大小没
 * 变就直接返回上次结果，变了只读新增的部分；已分类的 id 不再查库。`lsof` 带
 * `-n -P`（不做反向域名解析，断网时不会卡）并且异步，不占事件循环。
 *
 * 降级：Windows、读不到进程表、没有 `lsof` 且没有 `/proc`、日志读不了，都答
 * `undefined`——不显示，不报错。
 */

export interface AgySessionDeps {
  platform(): NodeJS.Platform;
  /** `rootPid` 自己和它所有后代里的 agy 进程号；进程表读不到答 `undefined`。 */
  agyPids(rootPid: number): number[] | undefined;
  /** 这个进程打开着的 `cli-*.log`；读不了答 `undefined`。 */
  heldLogs(pid: number): Promise<string[] | undefined>;
  /** 日志现在的大小；读不了答 `undefined`。 */
  logSize(path: string): number | undefined;
  /** 从 `from` 字节读到尾；读不了答 `undefined`。 */
  readLogFrom(path: string, from: number): Buffer | undefined;
  /** 这些 id 在索引库里是什么；库读不了答 `undefined`，库里没有的 id 不在结果里。 */
  classify(ids: readonly string[]): Map<string, "top" | "child"> | undefined;
  /** `~/.gemini/antigravity-cli`。 */
  stateDir(): string | undefined;
  exists(path: string): boolean;
}

export interface AgySession {
  readonly sessionId: string;
  /** 转录的绝对路径（文件可能还没写出来）。 */
  readonly transcriptPath: string;
  readonly logPath: string;
}

/** glog 行首：`I1124 21:23:48.548734  630 file.go:1269] `。 */
const GLOG = String.raw`^[IWEF]\d{4} [\d:.]+\s+\d+ [\w.]+\.go:\d+\] `;
const ID = String.raw`([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b`;
const CREATED = new RegExp(
  String.raw`^[IWEF]\d{4} [\d:.]+\s+\d+ server\.go:\d+\] Created conversation ${ID}`,
  "gm",
);
const ACTIVE = new RegExp(
  `${GLOG}(?:Sending user message to conversation|Streaming conversation) ${ID}`,
  "gm",
);

/** 日志里按出现顺序的 `Created conversation <id>`，去重。 */
export function createdConversations(log: string): string[] {
  const ids: string[] = [];
  for (const match of log.matchAll(CREATED)) {
    const id = match[1] as string;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 日志里按出现顺序的「正在说话」的会话 id（相邻重复折叠）。 */
export function activeConversations(log: string): string[] {
  const ids: string[] = [];
  for (const match of log.matchAll(ACTIVE)) {
    const id = match[1] as string;
    if (ids[ids.length - 1] !== id) ids.push(id);
  }
  return ids;
}

/** 转录文件：优先 `transcript.jsonl`，只有 `transcript_full.jsonl` 时用它。 */
export function transcriptOf(
  stateDir: string,
  sessionId: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const logs = join(stateDir, "brain", sessionId, ".system_generated", "logs");
  const primary = join(logs, "transcript.jsonl");
  const full = join(logs, "transcript_full.jsonl");
  return exists(primary) || !exists(full) ? primary : full;
}

/** 一个 agy 进程的日志读到哪里、读出了什么。 */
interface ProcessState {
  readonly agyPid: number;
  logPath: string | undefined;
  /** 已经消费到的字节（只到最后一个完整行）。 */
  offset: number;
  size: number;
  created: string[];
  active: string[];
  readonly top: Set<string>;
  readonly child: Set<string>;
  last: AgySession | undefined;
  /** 有候选但还没法下结论（库里还没有、索引读不了）：大小没变也要再试。 */
  unresolved: boolean;
}

const MAX_STATES = 64;

export class AgySessionResolver {
  private readonly states = new Map<number, ProcessState>();

  constructor(private readonly deps: AgySessionDeps) {}

  async resolve(rootPid: number | undefined): Promise<AgySession | undefined> {
    const deps = this.deps;
    if (rootPid === undefined || deps.platform() === "win32") return undefined;
    const stateDir = deps.stateDir();
    if (stateDir === undefined) return undefined;
    const pids = deps.agyPids(rootPid);
    // 没有、或不止一个 agy 进程：不猜。
    if (pids === undefined || pids.length !== 1) {
      this.states.delete(rootPid);
      return undefined;
    }
    const agyPid = pids[0] as number;
    let state = this.states.get(rootPid);
    if (state === undefined || state.agyPid !== agyPid) {
      state = newState(agyPid);
      this.states.set(rootPid, state);
      while (this.states.size > MAX_STATES) {
        const oldest = this.states.keys().next().value;
        if (oldest === undefined) break;
        this.states.delete(oldest);
      }
    }
    if (state.logPath === undefined) {
      const logs = await deps.heldLogs(agyPid);
      const own = join(stateDir, "log") + sep;
      // 日志必须在 agy 自己的 `log/` 下：别的进程持有的同名文件不算。
      const mine = (logs ?? []).filter((path) => path.startsWith(own));
      if (mine.length !== 1) return undefined;
      state.logPath = mine[0] as string;
    }
    const size = deps.logSize(state.logPath);
    if (size === undefined) return undefined;
    if (size < state.offset) {
      // 被截断或换了文件：从头再读。
      state.offset = 0;
      state.created = [];
      state.active = [];
      state.last = undefined;
    }
    const grew = size !== state.size;
    if (!grew && !state.unresolved && state.last !== undefined) {
      return state.last;
    }
    if (size > state.offset) {
      const chunk = deps.readLogFrom(state.logPath, state.offset);
      // 读不出来就不记大小：下一次还要再读，不能把没读到的当成读过了。
      if (chunk === undefined) return undefined;
      const end = chunk.lastIndexOf(0x0a);
      if (end >= 0) {
        const text = chunk.subarray(0, end + 1).toString("utf8");
        state.offset += end + 1;
        for (const id of createdConversations(text)) {
          if (!state.created.includes(id)) state.created.push(id);
        }
        for (const id of activeConversations(text)) {
          if (state.active[state.active.length - 1] !== id)
            state.active.push(id);
        }
        // 只留最近的一些：当前会话只看最后几条。
        if (state.active.length > 64)
          state.active.splice(0, state.active.length - 64);
      }
    }
    state.size = size;
    const chosen = this.choose(state);
    state.last =
      chosen === undefined
        ? undefined
        : {
            sessionId: chosen,
            transcriptPath: transcriptOf(stateDir, chosen, deps.exists),
            logPath: state.logPath,
          };
    return state.last;
  }

  /** 候选按「最近说话」优先、再按「最近创建」，第一个确认是顶层的就是当前会话。 */
  private choose(state: ProcessState): string | undefined {
    const candidates: string[] = [];
    for (const id of [...state.active].reverse()) {
      if (!candidates.includes(id)) candidates.push(id);
    }
    for (const id of [...state.created].reverse()) {
      if (!candidates.includes(id)) candidates.push(id);
    }
    state.unresolved = false;
    if (candidates.length === 0) return undefined;
    const unknown = candidates.filter(
      (id) => !state.top.has(id) && !state.child.has(id),
    );
    if (unknown.length > 0) {
      const kinds = this.deps.classify(unknown.slice(0, 16));
      if (kinds === undefined) {
        // 索引读不了：只有整份日志里恰好一个会话 id 才用。
        state.unresolved = true;
        const distinct = new Set(candidates);
        return distinct.size === 1 ? candidates[0] : undefined;
      }
      for (const [id, kind] of kinds) {
        (kind === "top" ? state.top : state.child).add(id);
      }
    }
    for (const id of candidates) {
      if (state.top.has(id)) {
        // 选中的顶层前面（更近）还排着库里没有的 id：`/new` 之后新会话晚进索引库，
        // 日志不再变化也要再问，否则会一直停在旧会话。
        const ahead = candidates.slice(0, candidates.indexOf(id));
        state.unresolved = ahead.some(
          (other) => !state.child.has(other) && !state.top.has(other),
        );
        return id;
      }
    }
    // 没有确认的顶层：还有库里没有的 id，稍后再问。
    state.unresolved = candidates.some((id) => !state.child.has(id));
    return undefined;
  }
}

function newState(agyPid: number): ProcessState {
  return {
    agyPid,
    logPath: undefined,
    offset: 0,
    size: -1,
    created: [],
    active: [],
    top: new Set(),
    child: new Set(),
    last: undefined,
    unresolved: false,
  };
}

/* ------------------------------ real readers ------------------------------ */

const HELD_LOG = /[\\/]antigravity-cli[\\/]log[\\/]cli-[^\\/]+\.log$/;

/** `rootPid` 与它的后代里叫 `agy` 的进程。 */
export function agyPidsUnder(table: ProcessTable, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of table.parents) {
    const list = children.get(parent) ?? [];
    list.push(pid);
    children.set(parent, list);
  }
  const found: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (table.names.get(pid) === "agy") found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

/** `lsof -Fn` 的输出里 agy 日志的那些行（`n<路径>`）。 */
export function parseLsofNames(stdout: string): string[] {
  const held = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("n") && HELD_LOG.test(line.slice(1))) {
      held.add(line.slice(1));
    }
  }
  return [...held];
}

/**
 * Linux 读 `/proc/<pid>/fd`，其余平台 `lsof -n -P -a -p <pid> -Fn`（异步；`-n -P`
 * 不做主机名与端口名解析——agy 有常驻的 TCP 连接，不带它们断网时 lsof 会卡住）。
 * 都不行答 `undefined`。
 */
export async function heldLogsOf(pid: number): Promise<string[] | undefined> {
  if (process.platform === "linux") {
    try {
      const held = new Set<string>();
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (HELD_LOG.test(target)) held.add(target);
        } catch {
          // 这个 fd 刚关掉。
        }
      }
      return [...held];
    } catch {
      return undefined;
    }
  }
  return new Promise((resolve) => {
    execFile(
      "lsof",
      lsofArguments(pid),
      { encoding: "utf8", timeout: 3_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        // lsof 找不到进程时退出码非零且没有输出；没有 lsof 是 ENOENT。
        if (typeof stdout !== "string" || stdout === "") {
          resolve(error === null ? [] : undefined);
          return;
        }
        resolve(parseLsofNames(stdout));
      },
    );
  });
}

export function lsofArguments(pid: number): string[] {
  return ["-n", "-P", "-a", "-p", String(pid), "-Fn"];
}

export const realAgySessionDeps: AgySessionDeps = {
  platform: () => process.platform,
  agyPids: (rootPid) => {
    const table = psProcessTable();
    return table === undefined ? undefined : agyPidsUnder(table, rootPid);
  },
  heldLogs: heldLogsOf,
  logSize: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  },
  readLogFrom: (path, from) => {
    try {
      const descriptor = openSync(path, "r");
      try {
        const size = fstatSync(descriptor).size;
        const buffer = Buffer.alloc(Math.max(0, size - from));
        readSync(descriptor, buffer, 0, buffer.length, from);
        return buffer;
      } finally {
        closeSync(descriptor);
      }
    } catch {
      return undefined;
    }
  },
  classify: (ids) => {
    const root = roots()[0];
    return root === undefined ? undefined : classifyConversations(root, ids);
  },
  stateDir: () => {
    const database = roots()[0];
    return database === undefined
      ? join(homedir(), ".gemini", "antigravity-cli")
      : join(database, "..");
  },
  exists: existsSync,
};
