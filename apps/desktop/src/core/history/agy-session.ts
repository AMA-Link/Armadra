import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type ProcessTable, psProcessTable } from "../hook/sources/grok-events";
import { roots, topLevelAmong } from "./agy";

/**
 * 终端里的 agy 没有 hook，怎么知道它此刻在哪个会话里（#1036，观察级，不进任何门）。
 *
 * 实测事实（agy 1.5.16 / 1.5.17，只读本机文件，没有发模型请求）：每个 agy **进程**
 * 自己持有一个日志文件 `~/.gemini/antigravity-cli/log/cli-<启动时刻>.log`（`lsof -p
 * <pid>` 能看到它被这个进程打开），里面有创建会话的那一行
 * `Created conversation <id> (backend=…)`。用四个已有的测试会话逐个对过：每个会话 id
 * 恰好出现在创建它的那个进程的日志里，一一对应。所以
 *
 *     节点的终端进程 → 它的后代里的 agy 进程 → 它持有的 cli-*.log → Created conversation
 *
 * 是没有歧义的映射，不依赖 cwd，也不依赖 hook。反查 cwd 之所以歧义（同一目录可以有
 * 多个会话，子代理会话也在同一个索引库里），这里一概不用。
 *
 * 一个进程的日志里可以有多条 `Created conversation`（`/new`、子代理）。规则（保守）：
 *   * 只认索引库确认是顶层（无父会话、深度 0）的那些；库里还没有的 id（刚创建、
 *     或子代理）不认；
 *   * 取日志里**最后出现**的那一条已确认的——`/new` 之后当前会话是最近创建的那个；
 *   * 索引库读不了时，只有日志里恰好一个 id 才用，多于一个就不显示。
 * 子代理是否也写这一行，没有真账号的子代理回合没法确认（见 #1036），所以靠索引库
 * 的父会话信息兜底，而不是靠「它不会写」。
 *
 * 降级：Windows、读不到进程表、没有 `lsof` 且没有 `/proc`、日志读不了，都答
 * `undefined`——不显示，不报错。
 */

export interface AgySessionDeps {
  platform(): NodeJS.Platform;
  /** `rootPid` 自己和它所有后代里的 agy 进程号；进程表读不到答 `undefined`。 */
  agyPids(rootPid: number): number[] | undefined;
  /** 这个进程打开着的 `cli-*.log`；读不了答 `undefined`。 */
  heldLogs(pid: number): string[] | undefined;
  readLog(path: string): string | undefined;
  /** 这些 id 里索引库确认的顶层会话；库读不了答 `undefined`。 */
  topLevel(ids: readonly string[]): Set<string> | undefined;
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

const CREATED =
  /Created conversation ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/g;

/** 日志里按出现顺序的 `Created conversation <id>`，去重。 */
export function createdConversations(log: string): string[] {
  const ids: string[] = [];
  for (const match of log.matchAll(CREATED)) {
    const id = match[1] as string;
    if (!ids.includes(id)) ids.push(id);
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

export function resolveAgySession(
  deps: AgySessionDeps,
  rootPid: number | undefined,
): AgySession | undefined {
  if (rootPid === undefined || deps.platform() === "win32") return undefined;
  const stateDir = deps.stateDir();
  if (stateDir === undefined) return undefined;
  const pids = deps.agyPids(rootPid);
  if (pids === undefined || pids.length !== 1) return undefined;
  const logs = deps.heldLogs(pids[0] as number);
  if (logs === undefined || logs.length !== 1) return undefined;
  const logPath = logs[0] as string;
  const text = deps.readLog(logPath);
  if (text === undefined) return undefined;
  const created = createdConversations(text);
  if (created.length === 0) return undefined;
  const confirmed = deps.topLevel(created);
  let chosen: string | undefined;
  if (confirmed === undefined) {
    chosen = created.length === 1 ? created[0] : undefined;
  } else {
    for (const id of created) if (confirmed.has(id)) chosen = id;
  }
  if (chosen === undefined) return undefined;
  return {
    sessionId: chosen,
    transcriptPath: transcriptOf(stateDir, chosen, deps.exists),
    logPath,
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

/** Linux 读 `/proc/<pid>/fd`，其余平台 `lsof -p <pid> -Fn`；都不行答 `undefined`。 */
export function heldLogsOf(pid: number): string[] | undefined {
  if (process.platform === "linux") {
    try {
      const fds = readdirSync(`/proc/${pid}/fd`);
      const held = new Set<string>();
      for (const fd of fds) {
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
  const result = spawnSync("lsof", ["-p", String(pid), "-Fn"], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined || typeof result.stdout !== "string") {
    return undefined;
  }
  // lsof 找不到进程时退出码非零但可能没有输出；输出为空按「读不了」。
  if (result.stdout === "") return undefined;
  const held = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("n") && HELD_LOG.test(line.slice(1))) {
      held.add(line.slice(1));
    }
  }
  return [...held];
}

export const realAgySessionDeps: AgySessionDeps = {
  platform: () => process.platform,
  agyPids: (rootPid) => {
    const table = psProcessTable();
    return table === undefined ? undefined : agyPidsUnder(table, rootPid);
  },
  heldLogs: heldLogsOf,
  readLog: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  topLevel: (ids) => {
    const root = roots()[0];
    return root === undefined ? undefined : topLevelAmong(root, ids);
  },
  stateDir: () => {
    const database = roots()[0];
    return database === undefined
      ? join(homedir(), ".gemini", "antigravity-cli")
      : join(database, "..");
  },
  exists: existsSync,
};
