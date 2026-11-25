import {
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir } from "../agent/fixture";
import { listConversations, refresh } from "../conversations";
import { openDatabase } from "../db/open";
import {
  APP_DATA_DIR,
  KEY_PREFIX,
  REQUIRED_COLUMNS,
  agyAdapter,
  candidates,
  cwdOf,
  forceOpenModeForTest,
  forgetLastGoodForTest,
  forgetSweepForTest,
  isoOf,
  locate,
  parse,
  probe,
  readEntries,
  roots,
  sessionIdOf,
  setCopyHooksForTest,
  setMaxCopyBytesForTest,
  setWarningLog,
} from "./agy";
import { availabilityOf } from "./availability";
import {
  HISTORY_ADAPTERS,
  historyAdapter,
  locateHistory,
  locateReadableHistory,
} from "./registry";

/**
 * Antigravity 的会话索引适配器（#997 批 2）。库是测试自己建的：**结构**取自真机
 * 上 1.5.16 的 `conversation_summaries` 表（列名与类型），行全是合成的——没有任
 * 何真实对话内容。
 */

const SCHEMA =
  "CREATE TABLE `conversation_summaries` (" +
  '`conversation_id` text, `title` text NOT NULL DEFAULT "", ' +
  '`preview` text NOT NULL DEFAULT "", `step_count` integer NOT NULL DEFAULT 0, ' +
  "`last_modified_time` datetime NOT NULL, `workspace_uris` text NOT NULL, " +
  '`status` text NOT NULL DEFAULT "", `source` text NOT NULL DEFAULT "", ' +
  '`project_id` text NOT NULL DEFAULT "", `agent_name` text NOT NULL DEFAULT "", ' +
  '`parent_conversation_id` text NOT NULL DEFAULT "", ' +
  '`nesting_depth` integer NOT NULL DEFAULT 0, `battle_id` text NOT NULL DEFAULT "", ' +
  '`winning_conversation_id` text NOT NULL DEFAULT "", ' +
  "`not_fully_idle` numeric NOT NULL DEFAULT false, `killed` numeric NOT NULL DEFAULT false, " +
  "`last_user_input_time` datetime NOT NULL, " +
  "`last_user_input_step_index` integer NOT NULL DEFAULT -1, " +
  '`app_data_dir` text NOT NULL DEFAULT "", `raw_summary` blob, ' +
  '`group_id` text NOT NULL DEFAULT "", PRIMARY KEY (`conversation_id`))';

let directory: string;
let home: string;
let dbPath: string;
let warnings: unknown[];
let previousLog: ReturnType<typeof setWarningLog>;
let previousHome: string | undefined;

beforeEach(() => {
  forgetLastGoodForTest();
  directory = mkdtempSync(join(tmpdir(), "armadra-agy-history-"));
  home = join(directory, "home");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  dbPath = join(
    home,
    ".gemini",
    "antigravity-cli",
    "conversation_summaries.db",
  );
  previousHome = process.env.HOME;
  process.env.HOME = home;
  warnings = [];
  previousLog = setWarningLog({
    warn: (message, fields) => warnings.push({ message, fields }),
  });
});

afterEach(() => {
  forceOpenModeForTest();
  setCopyHooksForTest();
  forgetLastGoodForTest();
  setWarningLog(previousLog);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

interface Row {
  id: string;
  title?: string;
  preview?: string;
  steps?: number;
  modified?: string;
  userInput?: string;
  uris?: string;
  parent?: string;
  depth?: number;
  app?: string;
}

function seed(database: DatabaseSync, rows: readonly Row[]): void {
  const insert = database.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, " +
      "last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, " +
      "last_user_input_time, app_data_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.title ?? "",
      row.preview ?? "",
      row.steps ?? 3,
      row.modified ?? "2026-11-20 10:00:00.000000+00:00",
      row.uris ?? '["file:///work/app"]',
      row.parent ?? "",
      row.depth ?? 0,
      row.userInput ?? "2026-11-20 10:00:00.000000+00:00",
      row.app ?? APP_DATA_DIR,
    );
  }
}

function createDatabase(rows: readonly Row[] = []): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(SCHEMA);
  seed(database, rows);
  return database;
}

const MIXED: readonly Row[] = [
  {
    id: "c-old",
    title: "旧会话",
    modified: "2026-11-01 08:00:00.000000+00:00",
  },
  {
    id: "c-new",
    title: "新会话",
    modified: "2026-11-21 09:30:00.500000+00:00",
  },
  // 标题没起好：退回预览。
  {
    id: "c-preview",
    title: "",
    preview: "帮我看看 CI",
    uris: '["file:///work/my%20app"]',
  },
  // IDE 的会话（共用库）。
  { id: "ide-1", title: "IDE 会话", app: "antigravity" },
  // 子代理的会话。
  { id: "sub-1", title: "子代理", parent: "c-new", depth: 1 },
  { id: "sub-2", title: "深一层", depth: 2 },
  // 空会话（从未写过）。
  { id: "empty", title: "", steps: 0, modified: "0001-01-01 00:00:00+00:00" },
];

describe("路径与键", () => {
  it("索引库在 ~/.gemini/antigravity-cli 下，没有家目录就没有根", () => {
    expect(roots({ HOME: "/h" })).toEqual([
      join("/h", ".gemini", "antigravity-cli", "conversation_summaries.db"),
    ]);
    expect(roots({ HOME: "", USERPROFILE: "" })).toEqual([]);
  });

  it("键是 agy:<会话 id>，定位只认带 sessionId 的线索", () => {
    expect(sessionIdOf("agy:abc")).toBe("abc");
    expect(sessionIdOf("opencode:abc")).toBeUndefined();
    expect(sessionIdOf(KEY_PREFIX)).toBeUndefined();
    expect(locate({ agentId: "agy", sessionId: "abc" })).toEqual({
      key: "agy:abc",
      origin: "Antigravity 会话 abc",
    });
    expect(locate({ agentId: "agy" })).toBeUndefined();
    expect(locateHistory({ agentId: "agy", sessionId: "abc" })).toMatchObject({
      key: "agy:abc",
    });
  });

  it("工作区 URI 转成路径，坏的是空串；时间戳转成 UTC，从未写过的是 undefined", () => {
    expect(cwdOf('["file:///work/my%20app"]')).toBe("/work/my app");
    expect(cwdOf('["file:///a","file:///b"]')).toBe("/a");
    expect(cwdOf("[]")).toBe("");
    expect(cwdOf("not json")).toBe("");
    expect(cwdOf('["https://example.com"]')).toBe("");
    // 两种形状在任何平台上结果一样：不借 `fileURLToPath` 的平台判断。
    expect(cwdOf('["file:///C:/Users/me/my%20app"]')).toBe(
      "C:\\Users\\me\\my app",
    );
    expect(cwdOf('["file:///c:/"]')).toBe("c:\\");
    expect(cwdOf('["file://localhost/work/app"]')).toBe("/work/app");
    expect(cwdOf('["file://server/share/dir"]')).toBe("\\\\server\\share\\dir");
    expect(cwdOf('["file:///work/app%"]')).toBe("");
    expect(cwdOf('["file://"]')).toBe("");
    expect(isoOf("2026-11-21 09:30:00.500000+00:00")).toBe(
      "2026-11-21T09:30:00.500Z",
    );
    expect(isoOf("0001-01-01 00:00:00+00:00")).toBeUndefined();
    expect(isoOf("")).toBeUndefined();
    expect(isoOf("garbage")).toBeUndefined();
  });
});

describe("会话索引", () => {
  it("只列 CLI 的顶层、写过东西的会话，最近更新的在前", () => {
    createDatabase(MIXED).close();
    const found = candidates(dbPath);
    expect(found.map((candidate) => candidate.path)).toEqual([
      "agy:c-new",
      "agy:c-preview",
      "agy:c-old",
    ]);
    expect(found[0]?.updatedAt).toBe("2026-11-21T09:30:00.500Z");
    expect(found.every((candidate) => candidate.bytes === 0)).toBe(true);
  });

  it("标题取 title，空了退回 preview；cwd 取第一个工作区；parse 不再开库", () => {
    createDatabase(MIXED).close();
    const found = candidates(dbPath);
    const byKey = Object.fromEntries(
      found.map((candidate) => [candidate.path, parse(candidate)]),
    );
    expect(byKey["agy:c-new"]).toEqual({
      sessionId: "c-new",
      title: "新会话",
      cwd: "/work/app",
    });
    expect(byKey["agy:c-preview"]).toEqual({
      sessionId: "c-preview",
      title: "帮我看看 CI",
      cwd: "/work/my app",
    });
    // 缓存对不上（更新时间不同）就现读。
    expect(parse({ path: "agy:c-new", updatedAt: "", bytes: 0 })).toMatchObject(
      { sessionId: "c-new", title: "新会话" },
    );
    expect(
      parse({ path: "agy:nobody", updatedAt: "", bytes: 0 }),
    ).toBeUndefined();
    expect(
      parse({ path: "other:c-new", updatedAt: "", bytes: 0 }),
    ).toBeUndefined();
  });

  it("接进适配器注册表与会话索引：能列出来，能被清掉，IDE 与子代理不进", () => {
    expect(historyAdapter("agy")).toBe(agyAdapter);
    expect(HISTORY_ADAPTERS.map((adapter) => adapter.agentId)).toContain("agy");
    createDatabase(MIXED).close();
    const opened = openDatabase({
      file: join(directory, "canvas.db"),
      migrationsDir: migrationsDir(),
    });
    try {
      const index = opened.database;
      expect(refresh(index, [["agy", dbPath]])).toMatchObject({
        scanned: 3,
        indexed: 3,
        removed: 0,
      });
      expect(refresh(index, [["agy", dbPath]])).toMatchObject({
        scanned: 3,
        indexed: 0,
        removed: 0,
      });
      const listed = listConversations(index, undefined, 10);
      expect(listed.map((row) => row.sessionId)).toEqual([
        "c-new",
        "c-preview",
        "c-old",
      ]);
      expect(listed.every((row) => row.provider === "agy")).toBe(true);
      expect(listed.map((row) => row.sessionId)).not.toContain("ide-1");
      expect(listed.map((row) => row.sessionId)).not.toContain("sub-1");
      rmSync(dbPath);
      expect(refresh(index, [["agy", dbPath]])).toMatchObject({
        removed: 3,
        total: 0,
      });
    } finally {
      opened.close();
    }
  });
});

describe("怎么打开库", () => {
  /** 一个开着的写连接 + 检查点之后又写了一行：那一行只在 WAL 里。 */
  function withWalRow(): DatabaseSync {
    const writer = createDatabase([{ id: "c-old", title: "旧会话" }]);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed(writer, [{ id: "c-wal", title: "只在 WAL 里" }]);
    return writer;
  }

  it("复制后读：看得到只在 WAL 里的新行，临时副本读完就没了", () => {
    const writer = withWalRow();
    try {
      const before = readdirSync(tmpdir()).filter((name) =>
        name.startsWith("armadra-agy-"),
      );
      forceOpenModeForTest("copy");
      expect(probe(dbPath)).toEqual({ state: "ok", mode: "copy" });
      expect(
        candidates(dbPath)
          .map((c) => c.path)
          .sort(),
      ).toEqual(["agy:c-old", "agy:c-wal"]);
      const after = readdirSync(tmpdir()).filter((name) =>
        name.startsWith("armadra-agy-"),
      );
      expect(after).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("immutable=1：不失败、不写任何东西，但看不到 WAL 里还没检查点的行", () => {
    const writer = withWalRow();
    try {
      const listing = () => readdirSync(join(dbPath, "..")).sort();
      const before = listing();
      forceOpenModeForTest("immutable");
      expect(probe(dbPath)).toEqual({ state: "ok", mode: "immutable" });
      expect(candidates(dbPath).map((c) => c.path)).toEqual(["agy:c-old"]);
      // agy 的目录里没有多出任何文件（尤其不是 `-shm`）。
      expect(listing()).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("没有 WAL 的库（已检查点关闭）两种方式读到同一份，agy 的目录一个字节不动", () => {
    createDatabase(MIXED).close();
    const listing = () => readdirSync(join(dbPath, "..")).sort();
    const before = listing();
    forceOpenModeForTest("copy");
    const viaCopy = candidates(dbPath).map((c) => c.path);
    forceOpenModeForTest("immutable");
    const viaImmutable = candidates(dbPath).map((c) => c.path);
    expect(viaCopy).toEqual(viaImmutable);
    expect(listing()).toEqual(before);
  });

  it("默认先复制；复制不了（超过上限）退到 immutable 而不是失败", () => {
    createDatabase(MIXED).close();
    expect(probe(dbPath)).toEqual({ state: "ok", mode: "copy" });
    setMaxCopyBytesForTest(1);
    try {
      expect(probe(dbPath)).toEqual({ state: "ok", mode: "immutable" });
      expect(candidates(dbPath)).toHaveLength(3);
    } finally {
      setMaxCopyBytesForTest();
    }
  });

  it("库不存在、列不齐都是「这台机器上没有」，各给一次 warning，不抛", () => {
    expect(candidates(dbPath)).toEqual([]);
    expect(probe(dbPath)).toEqual({ state: "not-found", reason: "missing" });
    // 缺 `parent_conversation_id`：认不得这个库。
    const database = new DatabaseSync(dbPath);
    database.exec(
      "CREATE TABLE conversation_summaries (conversation_id text, title text)",
    );
    database.close();
    expect(candidates(dbPath)).toEqual([]);
    expect(candidates(dbPath)).toEqual([]);
    const result = probe(dbPath);
    expect(result).toMatchObject({
      state: "not-found",
      reason: "incompatible",
    });
    expect((result as { detail?: string }).detail).toContain(
      "parent_conversation_id",
    );
    expect(warnings).toHaveLength(1);
    expect(REQUIRED_COLUMNS).toContain("app_data_dir");
  });

  it("不是 SQLite 的文件：unreadable，不抛", () => {
    writeFileSync(dbPath, "not a database");
    expect(candidates(dbPath)).toEqual([]);
    expect(probe(dbPath)).toMatchObject({
      state: "not-found",
      reason: "unreadable",
    });
  });
});

describe("没有记录可读", () => {
  it("readEntries 答空、游标不动；可用性里转录是 unsupported，索引照常", () => {
    expect(readEntries({ key: "agy:x", origin: "" }, 7, 1024)).toEqual({
      entries: [],
      startOffset: 7,
      endOffset: 7,
    });
    expect(agyAdapter.cost).toBeUndefined();
    expect(agyAdapter.readsEntries).toBe(false);
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    createDatabase().close();
    expect(
      availabilityOf("agy", { customAgents: () => [] }, { HOME: home }),
    ).toEqual({
      index: "available",
      cost: "unsupported",
      transcript: "unsupported",
    });
    rmSync(dbPath);
    expect(
      availabilityOf("agy", { customAgents: () => [] }, { HOME: home }),
    ).toMatchObject({ index: "not-found", transcript: "unsupported" });
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("读失败不清空索引", () => {
  function tornSetup(): DatabaseSync {
    const writer = createDatabase([{ id: "c-old", title: "旧会话" }]);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed(writer, [{ id: "c-wal", title: "只在 WAL 里" }]);
    return writer;
  }

  it("复制主库与 WAL 之间 agy 做了检查点：发现副本撕裂，重试，读到完整的一份", () => {
    const writer = tornSetup();
    try {
      const attempts: number[] = [];
      setCopyHooksForTest({
        betweenCopies: (attempt) => {
          attempts.push(attempt);
          // 第一次复制中途：检查点把 WAL 清空，再写一行（salt 与大小都变了）。
          if (attempt === 1) {
            writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            seed(writer, [{ id: "c-late", title: "复制期间写的" }]);
          }
        },
      });
      expect(
        candidates(dbPath)
          .map((c) => c.path)
          .sort(),
      ).toEqual(["agy:c-late", "agy:c-old", "agy:c-wal"]);
      expect(attempts).toEqual([1, 2]);
    } finally {
      writer.close();
    }
  });

  it("两次复制之间 WAL 被检查点删掉也算撕裂，重试", () => {
    const writer = tornSetup();
    try {
      setCopyHooksForTest({
        betweenCopies: (attempt) => {
          if (attempt === 1) {
            writer.close();
            // 关库会检查点并删掉 `-wal`。
          }
        },
      });
      const found = candidates(dbPath).map((c) => c.path);
      expect(found.sort()).toEqual(["agy:c-old", "agy:c-wal"]);
    } finally {
      try {
        writer.close();
      } catch {
        // 已经关了。
      }
    }
  });

  it("每一次都撕裂：退到 immutable，仍然不是空列表", () => {
    const writer = tornSetup();
    try {
      let n = 0;
      setCopyHooksForTest({
        betweenCopies: () => {
          n += 1;
          seed(writer, [{ id: `c-torn-${n}`, title: "一直在写" }]);
        },
      });
      const found = candidates(dbPath);
      expect(found.length).toBeGreaterThan(0);
      expect(found.map((c) => c.path)).toContain("agy:c-old");
    } finally {
      writer.close();
    }
  });

  it("副本读出来是坏页（malformed）：换一份新副本重读", () => {
    createDatabase(MIXED).close();
    let copies = 0;
    setCopyHooksForTest({
      afterCopy: (copy) => {
        copies += 1;
        // 第一份副本被截断：打开或查询时 malformed。
        if (copies === 1) writeFileSync(copy, readFileSyncHead(copy, 1500));
      },
    });
    expect(candidates(dbPath)).toHaveLength(3);
    expect(copies).toBeGreaterThanOrEqual(2);
  });

  it("这一趟读不了就回上一趟读成功的，索引行不被清掉；库没了才清", () => {
    createDatabase(MIXED).close();
    const opened = openDatabase({
      file: join(directory, "canvas.db"),
      migrationsDir: migrationsDir(),
    });
    try {
      const index = opened.database;
      expect(refresh(index, [["agy", dbPath]])).toMatchObject({ indexed: 3 });
      // 库被写坏了（不是 SQLite）：读不了，不是「没有会话」。
      writeFileSync(dbPath, "this is not a database");
      writeFileSync(`${dbPath}-wal`, "");
      expect(candidates(dbPath).map((c) => c.path)).toEqual([
        "agy:c-new",
        "agy:c-preview",
        "agy:c-old",
      ]);
      expect(refresh(index, [["agy", dbPath]])).toMatchObject({
        removed: 0,
        total: 3,
      });
      expect(listConversations(index, undefined, 10)).toHaveLength(3);
      // 库没了：确实没有，清掉。
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`, { force: true });
      expect(refresh(index, [["agy", dbPath]])).toMatchObject({
        removed: 3,
        total: 0,
      });
    } finally {
      opened.close();
    }
  });

  it("从没读成功过、又读不了：是空，不抛", () => {
    writeFileSync(dbPath, "this is not a database");
    expect(candidates(dbPath)).toEqual([]);
  });

  it("列不认得（升级后改了表）：清掉，不留着旧的", () => {
    createDatabase(MIXED).close();
    expect(candidates(dbPath)).toHaveLength(3);
    rmSync(dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    const database = new DatabaseSync(dbPath);
    database.exec("CREATE TABLE conversation_summaries (conversation_id text)");
    database.close();
    expect(candidates(dbPath)).toEqual([]);
  });
});

describe("兜底与清理", () => {
  it("immutable 兜底给一次 warning，说清可能读不到最近几行", () => {
    createDatabase(MIXED).close();
    forceOpenModeForTest("immutable");
    candidates(dbPath);
    candidates(dbPath);
    const notes = warnings as {
      fields?: { reason?: string; detail?: string };
    }[];
    const immutable = notes.filter((w) => w.fields?.reason === "immutable");
    expect(immutable).toHaveLength(1);
    expect(immutable[0]?.fields?.detail).toContain("最近几行");
  });

  it("复制上限按主库加 -wal 的总和算：WAL 大就退到 immutable", () => {
    const writer = createDatabase([{ id: "c-old", title: "旧会话" }]);
    // 表结构落进主库，之后的行留在 WAL 里。
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seed(writer, [{ id: "c-wal", title: "只在 WAL 里" }]);
    try {
      const mainSize = statSync(dbPath).size;
      setMaxCopyBytesForTest(mainSize + 1);
      // 主库本身没超，但加上 WAL 超了。
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(1);
      expect(probe(dbPath)).toEqual({ state: "ok", mode: "immutable" });
    } finally {
      setMaxCopyBytesForTest();
      writer.close();
    }
  });

  it("首次使用时清掉超过几分钟的残留副本目录，新的不动", () => {
    createDatabase(MIXED).close();
    const stale = mkdtempSync(join(tmpdir(), "armadra-agy-"));
    const fresh = mkdtempSync(join(tmpdir(), "armadra-agy-"));
    const old = new Date(Date.now() - 30 * 60_000);
    utimesSync(stale, old, old);
    forgetSweepForTest();
    try {
      probe(dbPath);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("给读内容的读者的定位", () => {
  it("只有索引、没有记录的来源答 undefined；读标题的入口仍答 key", () => {
    const hint = { agentId: "agy", sessionId: "abc" };
    expect(locateHistory(hint)).toMatchObject({ key: "agy:abc" });
    expect(locateReadableHistory(hint)).toBeUndefined();
    // CLI 报来了一个真文件：照旧认。
    const file = join(directory, "reported.jsonl");
    writeFileSync(file, "");
    expect(
      locateReadableHistory({ ...hint, transcriptPath: file }),
    ).toMatchObject({ path: file });
  });

  it("有记录可读的来源不受影响", () => {
    const hint = { agentId: "opencode", sessionId: "ses_1" };
    expect(locateReadableHistory(hint)).toEqual(locateHistory(hint));
    expect(locateReadableHistory({ agentId: "claude" })).toEqual(
      locateHistory({ agentId: "claude" }),
    );
  });
});

function readFileSyncHead(path: string, bytes: number): Buffer {
  return readFileSync(path).subarray(0, bytes);
}
