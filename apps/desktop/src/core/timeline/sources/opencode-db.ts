/**
 * OpenCode 的库读取（设计 §5.2，历史适配器的库约定见 `history/opencode.ts`）。
 *
 * 只读打开、读完就关，从不长期持有连接：OpenCode 自己正开着它写。和历史适配器的
 * 「消息游标」不同，这里要看见**正在变**的内容（工具从 running 到 completed、助手
 * 一步步写完），所以游标是 `time_updated`（毫秒）：每次取 `message` 与 `part` 里
 * `time_updated >= 游标` 的行，同一毫秒的行会被再读一次——转换器按 id 幂等，重复无害。
 *
 * 一条记录一行 JSON，交给 `opencode.ts` 的转换器：
 *   `{"k":"s","title":…}`                         会话标题
 *   `{"k":"m","m":{…消息, id}}`                    一条消息（用户 / 助手）
 *   `{"k":"p","m":{…消息, id},"p":{…分块, id}}`     一个分块，带上它所在的消息
 */

import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { roots } from "../../history/opencode";
import type { SessionHint } from "../../history/types";
import { obj } from "./convert-util";
import { PollRunner } from "./poll-runner";
import { type StatFn, fsStat } from "./tailer";
import type { RecordSourceOptions, SourceRunner } from "./types";

/** 第一次接管只读最近这么多条消息，更早的按需导入。 */
export const FIRST_MESSAGES = 60;

export interface OpencodeCursor {
  readonly s: string;
  readonly t: number;
}

export function encodeOpencodeCursor(cursor: OpencodeCursor): string {
  return JSON.stringify({ v: 1, ...cursor });
}

export function decodeOpencodeCursor(
  text: string | undefined,
): OpencodeCursor | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.v !== 1 ||
      typeof value.s !== "string" ||
      typeof value.t !== "number"
    ) {
      return undefined;
    }
    return { s: value.s, t: value.t };
  } catch {
    return undefined;
  }
}

export interface OpencodeRead {
  readonly lines: string[];
  readonly cursor: OpencodeCursor;
  readonly reset: boolean;
}

interface Row {
  readonly id: string;
  readonly message_id?: string;
  readonly time_updated: number;
  readonly data: string;
}

function parseJson(text: unknown): Record<string, unknown> | undefined {
  try {
    return obj(JSON.parse(String(text)));
  } catch {
    return undefined;
  }
}

/** 这个线索对应哪个会话：hook 报的 id，否则同目录、启动之后最近更新的根会话。 */
export function sessionOf(
  database: DatabaseSync,
  hint: SessionHint,
): string | undefined {
  if (hint.sessionId !== undefined && hint.sessionId !== "") {
    return hint.sessionId;
  }
  if (hint.cwd === undefined || hint.startedAtMs === undefined) {
    return undefined;
  }
  const row = database
    .prepare(
      "SELECT id FROM session WHERE parent_id IS NULL AND directory = ? " +
        "AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1",
    )
    .get(hint.cwd, hint.startedAtMs) as { id: string } | undefined;
  return row?.id;
}

/**
 * 从游标之后读一批。`cursor` 为空或属于别的会话时是第一次：最近
 * {@link FIRST_MESSAGES} 条消息连同它们的分块，按创建顺序，当回填。
 */
export function readOpencode(
  database: DatabaseSync,
  sessionId: string,
  cursor: OpencodeCursor | undefined,
): OpencodeRead {
  const first = cursor === undefined || cursor.s !== sessionId;
  const lines: string[] = [];
  let newest = first ? 0 : (cursor?.t ?? 0);

  const session = database
    .prepare("SELECT title, time_updated FROM session WHERE id = ?")
    .get(sessionId) as { title: string; time_updated: number } | undefined;
  if (session !== undefined && (first || session.time_updated >= newest)) {
    lines.push(JSON.stringify({ k: "s", title: String(session.title ?? "") }));
    newest = Math.max(newest, Number(session.time_updated) || 0);
  }

  const messageData = new Map<string, Record<string, unknown>>();
  const info = (id: string, data: unknown): Record<string, unknown> => {
    const cached = messageData.get(id);
    if (cached !== undefined) return cached;
    const parsed = { ...(parseJson(data) ?? {}), id };
    messageData.set(id, parsed);
    return parsed;
  };

  if (first) {
    const messages = database
      .prepare(
        "SELECT id, time_created, time_updated, data FROM message " +
          "WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?",
      )
      .all(sessionId, FIRST_MESSAGES) as unknown as (Row & {
      time_created: number;
    })[];
    messages.reverse();
    const oldest = messages[0]?.time_created ?? 0;
    const parts = database
      .prepare(
        "SELECT id, message_id, time_updated, data FROM part " +
          "WHERE session_id = ? AND time_created >= ? ORDER BY id",
      )
      .all(sessionId, oldest) as unknown as Row[];
    const byMessage = new Map<string, Row[]>();
    for (const part of parts) {
      const list = byMessage.get(String(part.message_id)) ?? [];
      list.push(part);
      byMessage.set(String(part.message_id), list);
    }
    for (const message of messages) {
      const id = String(message.id);
      const m = info(id, message.data);
      newest = Math.max(newest, Number(message.time_updated) || 0);
      lines.push(JSON.stringify({ k: "m", m }));
      for (const part of byMessage.get(id) ?? []) {
        newest = Math.max(newest, Number(part.time_updated) || 0);
        lines.push(
          JSON.stringify({
            k: "p",
            m,
            p: { ...(parseJson(part.data) ?? {}), id: String(part.id) },
          }),
        );
      }
    }
  } else {
    const since = cursor?.t ?? 0;
    const messages = database
      .prepare(
        "SELECT id, time_updated, data FROM message WHERE session_id = ? " +
          "AND time_updated >= ? ORDER BY time_updated, id",
      )
      .all(sessionId, since) as unknown as Row[];
    const parts = database
      .prepare(
        "SELECT id, message_id, time_updated, data FROM part WHERE session_id = ? " +
          "AND time_updated >= ? ORDER BY time_updated, id",
      )
      .all(sessionId, since) as unknown as Row[];
    // 两路按更新时间合并，同一时刻消息在前。
    let mi = 0;
    let pi = 0;
    while (mi < messages.length || pi < parts.length) {
      const message = messages[mi];
      const part = parts[pi];
      const takeMessage =
        message !== undefined &&
        (part === undefined || message.time_updated <= part.time_updated);
      if (takeMessage) {
        mi++;
        newest = Math.max(newest, Number(message.time_updated) || 0);
        lines.push(
          JSON.stringify({ k: "m", m: info(String(message.id), message.data) }),
        );
        continue;
      }
      pi++;
      if (part === undefined) break;
      newest = Math.max(newest, Number(part.time_updated) || 0);
      const messageId = String(part.message_id);
      let m = messageData.get(messageId);
      if (m === undefined) {
        const row = database
          .prepare("SELECT data FROM message WHERE id = ?")
          .get(messageId) as { data: string } | undefined;
        m = info(messageId, row?.data);
      }
      lines.push(
        JSON.stringify({
          k: "p",
          m,
          p: { ...(parseJson(part.data) ?? {}), id: String(part.id) },
        }),
      );
    }
  }
  return { lines, cursor: { s: sessionId, t: newest }, reset: first };
}

/* --------------------------------- 读取器 --------------------------------- */

/** 打开库读一次；库不存在答 `undefined`（OpenCode 还没跑过）。 */
export function readDatabase(
  path: string,
  hint: SessionHint,
  cursor: OpencodeCursor | undefined,
): OpencodeRead | undefined {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const sessionId = sessionOf(database, hint);
    if (sessionId === undefined) return undefined;
    return readOpencode(database, sessionId, cursor);
  } finally {
    database.close();
  }
}

function fingerprintOf(path: string, stat: StatFn): string {
  const parts = [path, `${path}-wal`].map((file) => {
    const found = stat(file);
    return found === undefined ? "-" : `${found.size}:${found.mtimeMs}`;
  });
  return parts.join("|");
}

/** 适配器的 `source`：库文件和它的 WAL 一变就读。 */
export function opencodeSource(options: RecordSourceOptions): SourceRunner {
  const path = roots()[0];
  const stat = options.stat ?? fsStat;
  let cursor = decodeOpencodeCursor(options.initialCursor);
  return new PollRunner({
    read: () => {
      if (path === undefined || stat(path) === undefined) return;
      const result = readDatabase(path, options.hint(), cursor);
      if (result === undefined) return;
      cursor = result.cursor;
      if (result.lines.length > 0 || result.reset) {
        options.onRead({
          lines: result.lines,
          cursor: encodeOpencodeCursor(result.cursor),
          reset: result.reset,
        });
      }
    },
    fingerprint: () =>
      path === undefined ? undefined : fingerprintOf(path, stat),
    ...(path !== undefined
      ? { watchDirectory: dirname(path), watchPrefix: "opencode.db" }
      : {}),
    onError: options.onError,
    timers: options.timers,
    watch: options.watch,
  });
}
