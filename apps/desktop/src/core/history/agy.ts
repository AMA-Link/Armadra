import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Candidate,
  type Parsed,
  MAX_FILES_PER_PROVIDER,
  title as clampTitle,
} from "../conversations/scan";
import { createLog, logLevel } from "../platform";
import { isFile } from "./files";
import { homeDir } from "./home";
import type { EntryRange, HistoryAdapter, Located, SessionHint } from "./types";

/**
 * Antigravity（`agy`）— 会话索引库：`~/.gemini/antigravity-cli/conversation_summaries.db`。
 *
 * 一个会话一行（`conversation_summaries`，**普通列**，不是 protobuf）：`title`、
 * `preview`、`workspace_uris`、`last_modified_time`……每个会话自己的对话库
 * （`conversations/<id>.db`）里全是无 schema 的 protobuf，这里**不读**；会话内容的
 * 来源是每会话一份的 JSONL 转录，那是后续批次（转录时间线）的事。所以：
 *
 *   * 候选的 `path` 与定位结果的 `key` 都是不透明键 `agy:<会话 id>`；会话 id 就是
 *     ACP 的 `sessionId`（实测），所以索引里的一行能经 ACP 的 `session/load`
 *     接回，不需要终端的 `--resume`（agy 的终端没有会话 id 可接）。
 *   * 这家的适配器**没有记录可读**（`readsEntries: false`）：`readEntries` 答空，
 *     会话索引之外的读者（连线读取、摘要）按「这家没有转录」处理。
 *   * 不轮询、不写任何状态、没有成本来源。
 *
 * **共用库**：这个库与 Antigravity IDE（`app_data_dir = antigravity`）共用，IDE 的
 * 行混在里面，要按 `app_data_dir = 'antigravity-cli'` 过滤。**子代理的会话**（
 * `parent_conversation_id` 非空、`nesting_depth > 0`）不是顶层会话，没有人会去
 * 接回它，不进索引；没有步骤的空会话（`step_count = 0`，时间戳是 `0001-01-01`）同样不进。
 *
 * **怎么读**：库是 WAL 模式，agy 正开着它写。`-readonly` 直接打开会在 agy 的目录里
 * 建 `-shm`（写了别人的目录），`immutable=1` 不看 WAL（最近一次检查点之后的行
 * 读不到）。所以默认「复制后读」：把库与 `-wal` 复制到一个只有本用户可进的临时目录，
 * 在那里只读打开、读完立刻连目录一起删掉——看得到 WAL 里的新行，也不碰 agy 的目录。
 *
 * **复制会撕裂**：复制主库与 `-wal` 之间 agy 做了检查点，副本的两半不是同一时刻的，
 * 读出来要么 malformed、要么静默少行。所以复制前后各量一次（大小、mtime、WAL 头的
 * salt），不一致就重试（最多 3 次）；查询抛错先换一份新副本重读，再退到
 * `immutable=1`（可能漏掉最新几行，但不会失败、不写任何东西，给一次 warning）；
 * 主库加 `-wal` 超过 16 MB 也直接用它。
 *
 * **读失败不清空索引**：会话索引见到空列表就把这一家的行全清掉，而它没有周期扫描，
 * 清掉就一直空着。所以这一趟读不了回**上一趟读成功的**候选；库没了、列不认得才是空。
 * 版本靠 `PRAGMA table_info` 核对要读的列，列不齐按「这台机器上没有 agy 的记录」
 * 处理并给一次 warning，绝不抛到启动或扫描路径上。
 */

/** 不透明键的前缀：`agy:<会话 id>`。 */
export const KEY_PREFIX = "agy:";

/** 索引库里认的那一行 `app_data_dir`（IDE 是 `antigravity`）。 */
export const APP_DATA_DIR = "antigravity-cli";

/** 要读的列都在，才认这个库。 */
export const REQUIRED_COLUMNS = [
  "conversation_id",
  "title",
  "preview",
  "step_count",
  "last_modified_time",
  "last_user_input_time",
  "workspace_uris",
  "parent_conversation_id",
  "nesting_depth",
  "app_data_dir",
] as const;

/** 主库加 `-wal` 比这更大不复制（索引库实测几百 KB），直接退到 `immutable=1`。 */
export const MAX_COPY_BYTES = 16 * 1024 * 1024;
let maxCopyBytes = MAX_COPY_BYTES;
/** 测试用：换掉复制上限；不传则恢复。 */
export function setMaxCopyBytesForTest(bytes?: number): void {
  maxCopyBytes = bytes ?? MAX_COPY_BYTES;
}

/** `~/.gemini/antigravity-cli/conversation_summaries.db`。 */
export function roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homeDir(env);
  return home === undefined
    ? []
    : [join(home, ".gemini", "antigravity-cli", "conversation_summaries.db")];
}

function databasePath(): string | undefined {
  return roots()[0];
}

/* ---------------------------------- 打开 ---------------------------------- */

export type ProbeResult =
  | { readonly state: "ok"; readonly mode: OpenMode }
  | {
      readonly state: "not-found";
      readonly reason: "missing" | "incompatible" | "unreadable";
      readonly detail?: string;
    };

/** 怎么打开的：复制后读（看得到 WAL），还是 `immutable=1`（可能漏最近几行）。 */
export type OpenMode = "copy" | "immutable";

let log: { warn(message: string, fields?: Record<string, unknown>): void } =
  createLog(logLevel(process.env.ARMADRA_LOG));
const warned = new Set<string>();

/** 测试用：换掉 warning 的去处。返回之前那个。 */
export function setWarningLog(next: typeof log): typeof log {
  const previous = log;
  log = next;
  warned.clear();
  return previous;
}

/** 同一个库同一个原因只说一次：会话索引每次扫描都会走这里，不该每次都刷一行。 */
function warnOnce(path: string, reason: string, detail?: string): void {
  const key = `${path}\u0000${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn("Antigravity 的会话索引库读不了，这一家跳过", {
    path,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

interface Opened {
  readonly database: DatabaseSync;
  readonly mode: OpenMode;
  /** 关库并删掉临时副本。 */
  close(): void;
}

/** 测试用：强制走哪一条路（`undefined` = 先复制、复制不了再 immutable）。 */
let forcedMode: OpenMode | undefined;
export function forceOpenModeForTest(mode?: OpenMode): void {
  forcedMode = mode;
}

/** 副本撕裂（复制期间 agy 做了检查点）：重试，不当作库坏了。 */
class TornCopy extends Error {}

/** 复制前后量一次的东西：大小、mtime，以及 WAL 头里的 salt（偏移 16–24）。 */
interface Stamp {
  readonly mainSize: number;
  readonly mainMtime: number;
  readonly walSize: number;
  readonly walMtime: number;
  readonly walSalt: string;
}

function stampOf(path: string): Stamp {
  const main = statSync(path);
  let walSize = -1;
  let walMtime = -1;
  let walSalt = "";
  try {
    const wal = statSync(`${path}-wal`);
    walSize = wal.size;
    walMtime = wal.mtimeMs;
    if (wal.size >= 24) {
      const header = Buffer.alloc(24);
      const descriptor = openSync(`${path}-wal`, "r");
      try {
        readSync(descriptor, header, 0, 24, 0);
      } finally {
        closeSync(descriptor);
      }
      walSalt = header.subarray(16, 24).toString("hex");
    }
  } catch (error) {
    // 没有 WAL（已检查点）就只有主文件；别的错（权限）照常抛。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    mainSize: main.size,
    mainMtime: main.mtimeMs,
    walSize,
    walMtime,
    walSalt,
  };
}

/** 测试钩子：在复制的两步之间、或复制完成之后动手脚，造出撕裂的副本。 */
interface CopyHooks {
  readonly betweenCopies?: (attempt: number) => void;
  readonly afterCopy?: (copy: string, attempt: number) => void;
}
let copyHooks: CopyHooks = {};
export function setCopyHooksForTest(hooks: CopyHooks = {}): void {
  copyHooks = hooks;
}

/** 一次复制尝试；每次进来都从头量。 */
const COPY_ATTEMPTS = 3;

/** 复制 `db` 与 `-wal` 到一个私有临时目录，只读打开副本。失败抛出。 */
function openCopy(path: string): Opened {
  sweepStaleCopies();
  let torn: unknown;
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    try {
      return copyOnce(path, attempt);
    } catch (error) {
      if (!(error instanceof TornCopy)) throw error;
      torn = error;
    }
  }
  throw torn;
}

function copyOnce(path: string, attempt: number): Opened {
  const before = stampOf(path);
  // 上限按主库加 `-wal` 的总和算：WAL 可以比主库大得多。
  if (before.mainSize + Math.max(0, before.walSize) > maxCopyBytes) {
    throw new Error("the summaries database is too large to copy");
  }
  const directory = mkdtempSync(join(tmpdir(), COPY_PREFIX));
  let database: DatabaseSync | undefined;
  try {
    const copy = join(directory, "conversation_summaries.db");
    copyFileSync(path, copy);
    copyHooks.betweenCopies?.(attempt);
    if (before.walSize >= 0) {
      try {
        copyFileSync(`${path}-wal`, `${copy}-wal`);
      } catch (error) {
        // 两次复制之间 WAL 被检查点删掉了：撕裂，重试。
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new TornCopy("the WAL went away while copying");
        }
        throw error;
      }
    }
    // 复制期间主库或 WAL 动过（含检查点换了 salt）：副本主文件与 WAL 不是同一
    // 时刻的，读出来会 malformed 或静默少行。
    const after = stampOf(path);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new TornCopy("the database changed while copying");
    }
    copyHooks.afterCopy?.(copy, attempt);
    database = new DatabaseSync(copy, { readOnly: true });
    // 第一条语句才会去碰 `-shm`；在副本所在的目录里，它建得出来。
    database.prepare("PRAGMA table_info(conversation_summaries)").all();
    const opened = database;
    return {
      database: opened,
      mode: "copy",
      close() {
        try {
          opened.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // 已经坏了的句柄，关不关都一样。
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** 临时副本目录的前缀；进程被杀会留下残留，下面首次使用时清掉。 */
const COPY_PREFIX = "armadra-agy-";
const STALE_COPY_MS = 5 * 60_000;
let swept = false;

/** 模块首次使用时，清掉超过几分钟的残留副本目录（上一个进程被杀时留下的）。 */
function sweepStaleCopies(): void {
  if (swept) return;
  swept = true;
  try {
    const now = Date.now();
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(COPY_PREFIX)) continue;
      const path = join(tmpdir(), name);
      try {
        if (now - statSync(path).mtimeMs > STALE_COPY_MS) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // 别的进程刚删掉它：无所谓。
      }
    }
  } catch {
    // 临时目录读不了：不清，不影响读库。
  }
}

/** 测试用：让下一次使用重新清扫。 */
export function forgetSweepForTest(): void {
  swept = false;
}

/** `immutable=1`：不看 WAL、不建 `-shm`、不写任何东西。 */
function openImmutable(path: string): Opened {
  const uri = `file:${encodeURI(path).replaceAll("?", "%3F").replaceAll("#", "%23")}?immutable=1`;
  const database = new DatabaseSync(uri, { readOnly: true });
  return { database, mode: "immutable", close: () => database.close() };
}

/**
 * 一次打开尝试想说的话。**不在尝试里直接说**：同一趟读可能先复制失败、重试成功，
 * 或先 immutable 打开了、查询却读不了；只有最终结果定了，才说与这个结果对得上的
 * 那一条（{@link emitWarnings}）。
 */
interface PendingWarning {
  readonly reason: string;
  readonly detail?: string;
}

type OpenOutcome =
  | {
      readonly opened: Opened;
      readonly probe: ProbeResult;
      readonly warnings: readonly PendingWarning[];
    }
  | {
      readonly opened?: undefined;
      readonly probe: ProbeResult;
      readonly warnings: readonly PendingWarning[];
    };

function emitWarnings(path: string, warnings: readonly PendingWarning[]): void {
  for (const warning of warnings) {
    warnOnce(path, warning.reason, warning.detail);
  }
}

const IMMUTABLE_WARNING: PendingWarning = {
  reason: "immutable",
  detail: "复制不了，改用 immutable=1：可能读不到最近几行",
};

function openChecked(path: string, only?: OpenMode): OpenOutcome {
  if (!isFile(path)) {
    return { probe: { state: "not-found", reason: "missing" }, warnings: [] };
  }
  let opened: Opened | undefined;
  const modes: OpenMode[] =
    only !== undefined
      ? [only]
      : forcedMode === undefined
        ? ["copy", "immutable"]
        : [forcedMode];
  let failure: unknown;
  for (const mode of modes) {
    try {
      opened = mode === "copy" ? openCopy(path) : openImmutable(path);
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (opened === undefined) {
    const detail = describe(failure);
    return {
      probe: { state: "not-found", reason: "unreadable", detail },
      warnings: [{ reason: "unreadable", detail }],
    };
  }
  try {
    const columns = opened.database
      .prepare("PRAGMA table_info(conversation_summaries)")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => String(column.name)));
    const absent = REQUIRED_COLUMNS.filter((name) => !names.has(name));
    if (absent.length > 0) {
      opened.close();
      const detail = `conversation_summaries 缺少列：${absent.join(", ")}`;
      return {
        probe: { state: "not-found", reason: "incompatible", detail },
        warnings: [{ reason: "incompatible", detail }],
      };
    }
    return {
      opened,
      probe: { state: "ok", mode: opened.mode },
      warnings: opened.mode === "immutable" ? [IMMUTABLE_WARNING] : [],
    };
  } catch (error) {
    try {
      opened.close();
    } catch {
      // 同上。
    }
    const detail = describe(error);
    return {
      probe: { state: "not-found", reason: "unreadable", detail },
      warnings: [{ reason: "unreadable", detail }],
    };
  }
}

/** 一次读的结果：读到了，或者这个库「没有 / 不认识 / 这一趟读不了」。 */
export type ReadOutcome<T> =
  | { readonly state: "ok"; readonly value: T }
  | {
      readonly state: "missing" | "incompatible" | "unreadable";
      readonly detail?: string;
    };

/**
 * 只读打开、核对列、交给 `use`，最后一定关掉（含临时副本）。
 *
 * 复制模式下 `use`（查询）抛错——撕裂的副本、读到一半的页——不当作库坏了：先用一份
 * 新副本重读一次，再退到 `immutable=1`；都不行才是 `unreadable`。调用方据此区分
 * 「这一趟读不了」（保留上一趟的结果）与「库没了 / 不认识」（清掉）。
 */
function withDatabase<T>(
  path: string,
  use: (database: DatabaseSync) => T,
): ReadOutcome<T> {
  const plan: (OpenMode | undefined)[] =
    forcedMode === undefined ? ["copy", "copy", "immutable"] : [forcedMode];
  let last: ReadOutcome<T> = { state: "unreadable" };
  for (const mode of plan) {
    const { opened, probe: result, warnings } = openChecked(path, mode);
    if (opened === undefined) {
      if (result.state === "not-found") {
        if (result.reason === "missing" || result.reason === "incompatible") {
          emitWarnings(path, warnings);
          return {
            state: result.reason,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          };
        }
        last = {
          state: "unreadable",
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
      }
      continue;
    }
    try {
      const value = use(opened.database);
      // 最终读成了：只说这一次打开自己的话（immutable 可能漏行），之前几次失败的
      // 尝试不说。
      emitWarnings(path, warnings);
      return { state: "ok", value };
    } catch (error) {
      last = { state: "unreadable", detail: describe(error) };
    } finally {
      opened.close();
    }
  }
  // 每一次都没读成：说最后这个原因，一次。
  emitWarnings(path, [{ reason: "unreadable", detail: last.detail }]);
  return last;
}

/** 这个库现在能不能读（打开探测完立刻关掉）。给可用性检查与测试用。 */
export function probe(path: string): ProbeResult {
  const { opened, probe: result, warnings } = openChecked(path);
  opened?.close();
  emitWarnings(path, warnings);
  return result;
}

/* -------------------------------- 会话索引 -------------------------------- */

interface SummaryRow {
  readonly conversation_id: string;
  readonly title: string;
  readonly preview: string;
  readonly last_modified_time: string;
  readonly last_user_input_time: string;
  readonly workspace_uris: string;
}

const SELECT_SESSIONS =
  "SELECT conversation_id, title, preview, last_modified_time, " +
  "last_user_input_time, workspace_uris FROM conversation_summaries " +
  `WHERE app_data_dir = '${APP_DATA_DIR}' ` +
  "AND (parent_conversation_id IS NULL OR parent_conversation_id = '') " +
  "AND COALESCE(nesting_depth, 0) = 0 " +
  "AND COALESCE(step_count, 0) > 0 " +
  "AND conversation_id <> '' " +
  "ORDER BY last_modified_time DESC LIMIT ?";

/**
 * 上一趟 {@link candidates} 读出来的标题与 cwd，按候选的 `path` 存：索引紧接着对
 * 每个变了的候选调 `parse`，那一行刚读过，不必再复制一次库。
 */
let parsedCache = new Map<string, Parsed & { readonly updatedAt: string }>();

/**
 * 每个根上一趟**读成功**的候选（连同标题缓存）。读这一趟失败（复制撕裂、坏页、
 * 目录暂时读不了）时回它，而不是 `[]`：会话索引见到空列表会把这一家的行全清掉，
 * 而这张索引没有周期扫描，清掉就一直空着。库没了、认不得才清。
 */
const lastGood = new Map<
  string,
  {
    readonly found: Candidate[];
    readonly parsed: Map<string, Parsed & { readonly updatedAt: string }>;
  }
>();

/**
 * 顶层会话，一个会话一个候选，最近更新的在前。子代理会话、IDE 的会话、空会话
 * 不进索引（见文件头）。
 */
export function candidates(root: string): Candidate[] {
  unreadable.delete(root);
  const outcome = withDatabase(root, (database) => {
    const found: Candidate[] = [];
    const parsed = new Map<string, Parsed & { readonly updatedAt: string }>();
    const rows = database
      .prepare(SELECT_SESSIONS)
      .all(MAX_FILES_PER_PROVIDER) as unknown as SummaryRow[];
    for (const row of rows) {
      const id = String(row.conversation_id ?? "");
      if (id === "") continue;
      const updatedAt =
        isoOf(row.last_modified_time) ?? isoOf(row.last_user_input_time);
      if (updatedAt === undefined) continue;
      const path = `${KEY_PREFIX}${id}`;
      // 没有一个文件可以量；会话索引不读这个数。
      found.push({ path, updatedAt, bytes: 0 });
      parsed.set(path, {
        sessionId: id,
        title: titleOf(row),
        cwd: cwdOf(row.workspace_uris),
        updatedAt,
      });
    }
    return { found, parsed };
  });
  if (outcome.state === "ok") {
    lastGood.set(root, outcome.value);
    parsedCache = outcome.value.parsed;
    return outcome.value.found;
  }
  if (outcome.state === "unreadable") {
    // 这一趟读不了：保留上一趟的。从没读成功过才是空。
    unreadable.add(root);
    const previous = lastGood.get(root);
    if (previous !== undefined) parsedCache = previous.parsed;
    return previous?.found ?? [];
  }
  // 库没了、列不认得：这一家确实没有，清掉。
  lastGood.delete(root);
  parsedCache = new Map();
  return [];
}

/**
 * 最近一次 {@link candidates} 读不了的根。`lastGood` 只在同一个进程里有：重启后的
 * 第一趟就读不了时，它没有东西可回、只能答空——这时必须让会话索引知道「这是读不了，
 * 不是没有」，跳过对账，已有的行才不会被清掉。
 */
const unreadable = new Set<string>();

/** 最近一次 {@link candidates} 是不是读不了（适配器的 `listUnreadable`）。 */
export function listUnreadable(root: string): boolean {
  return unreadable.has(root);
}

/** 测试用：忘掉上一趟读成功的结果。 */
export function forgetLastGoodForTest(): void {
  lastGood.clear();
  unreadable.clear();
  parsedCache = new Map();
}

/**
 * 一个候选 → 会话 id、标题与 cwd。上一趟读过这一行、更新时间对得上时不再开库；
 * 对不上就现读（标题可能刚被 agy 起好）。
 */
export function parse(candidate: Candidate): Parsed | undefined {
  const id = sessionIdOf(candidate.path);
  if (id === undefined) return undefined;
  const cached = parsedCache.get(candidate.path);
  if (cached !== undefined && cached.updatedAt === candidate.updatedAt) {
    return { sessionId: id, title: clampTitle(cached.title), cwd: cached.cwd };
  }
  const path = databasePath();
  if (path === undefined) return undefined;
  const outcome = withDatabase(path, (database) => {
    const row = database
      .prepare(
        "SELECT conversation_id, title, preview, last_modified_time, " +
          "last_user_input_time, workspace_uris FROM conversation_summaries " +
          `WHERE app_data_dir = '${APP_DATA_DIR}' AND conversation_id = ?`,
      )
      .get(id) as unknown as SummaryRow | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: id,
      title: clampTitle(titleOf(row)),
      cwd: cwdOf(row.workspace_uris),
    };
  });
  return outcome.state === "ok" ? outcome.value : undefined;
}

/** 标题没起好（空）时退回预览（首条用户输入的开头）。 */
function titleOf(row: Pick<SummaryRow, "title" | "preview">): string {
  const title = String(row.title ?? "").trim();
  return clampTitle(title !== "" ? title : String(row.preview ?? ""));
}

/**
 * `workspace_uris` 是 JSON 数组（`["file:///Users/me/proj"]`）；取第一个，转成路径。
 * 读不出来（不是数组、不是 `file:`、解码失败）是空串——索引用目录名兜底。
 *
 * 转换只看 URI 自己，不看跑在哪个平台上：`fileURLToPath` 按当前平台解释，在 Windows
 * 上拒绝没有盘符的 `file:///work/app`，在 POSIX 上又把 agy 在 Windows 写的
 * `file:///C:/work/app` 当成相对路径。这里两种形状各给一个固定结果：
 *   - `file:///Users/me/proj` → `/Users/me/proj`
 *   - `file:///C:/Users/me/proj` → `C:\Users\me\proj`
 *   - `file://host/share/dir` → `\\host\share\dir`
 */
export function cwdOf(value: unknown): string {
  let list: unknown;
  try {
    list = JSON.parse(String(value ?? ""));
  } catch {
    return "";
  }
  return Array.isArray(list) ? pathOfUri(list[0]) : "";
}

function pathOfUri(first: unknown): string {
  if (typeof first !== "string") return "";
  const parsed = /^file:\/\/([^/?#]*)(\/[^?#]*)?(?:[?#].*)?$/i.exec(first);
  if (parsed === null) return "";
  const host = (parsed[1] ?? "").toLowerCase();
  let path: string;
  try {
    path = decodeURIComponent(parsed[2] ?? "");
  } catch {
    return "";
  }
  if (path === "" || path.includes("\0")) return "";
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  if (host === "" || host === "localhost") {
    return drive === null
      ? path
      : `${drive[1]}${(drive[2] ?? "\\").replaceAll("/", "\\")}`;
  }
  return `\\\\${host}${path.replaceAll("/", "\\")}`;
}

/**
 * `2026-10-13 17:25:26.053942+00:00` → RFC 3339 UTC。`0001-01-01…`（从未写过）与读
 * 不出来的都是 `undefined`。
 */
export function isoOf(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (text === "" || text.startsWith("0001-")) return undefined;
  const ms = Date.parse(text.replace(" ", "T"));
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** `agy:<id>` → `<id>`；不是这个前缀是 `undefined`。 */
export function sessionIdOf(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const id = key.slice(KEY_PREFIX.length);
  return id === "" ? undefined : id;
}

/* ---------------------------------- 定位 ---------------------------------- */

/** hook / ACP 报来的 `sessionId` 就是会话 id（也是键）；终端 agy 没有，答 `undefined`。 */
export function locate(hint: SessionHint): Located | undefined {
  const id = hint.sessionId;
  if (id === undefined || id === "") return undefined;
  return { key: `${KEY_PREFIX}${id}`, origin: `Antigravity 会话 ${id}` };
}

/* ---------------------------------- 记录 ---------------------------------- */

/** 这家没有记录可读（见文件头）：答空，游标不动。 */
export function readEntries(
  _located: Located,
  fromOffset: number,
  _maxBytes: number,
): EntryRange {
  return { entries: [], startOffset: fromOffset, endOffset: fromOffset };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* --------------------------------- 适配器 --------------------------------- */

export const agyAdapter: HistoryAdapter = {
  agentId: "agy",
  roots,
  locate,
  list: candidates,
  listUnreadable,
  parse,
  readEntries,
  readsEntries: false,
};
