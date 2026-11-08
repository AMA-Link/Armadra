// 场景 16 的来源转录夹具：各家 CLI 落盘的行形状（与 core/handoff/source-transcript.test.ts
// 的样本同形），以及 OpenCode 的库。
//
// 每家都是同一段小对话：用户问 `first ask`，助手调一个工具再答 `done`。探针据此断言
// 五种来源经 `handoff-read --part transcript` 读出的条目是同一个形状。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const line = (value) => `${JSON.stringify(value)}\n`;

export const FIRST_ASK = "first ask";
export const LAST_ANSWER = "done";

export const claudeLines = () => [
  line({ type: "user", message: { role: "user", content: FIRST_ASK } }),
  line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "a.ts" },
        },
      ],
    },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }],
    },
  }),
  line({
    type: "assistant",
    message: { role: "assistant", content: LAST_ANSWER },
  }),
];

export const codexLines = () => [
  line({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: FIRST_ASK }],
    },
  }),
  line({
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      arguments: '{"command":"ls"}',
      call_id: "c1",
    },
  }),
  line({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: LAST_ANSWER }],
    },
  }),
];

export const piLines = () => [
  line({ type: "message", message: { role: "user", content: FIRST_ASK } }),
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        {
          type: "toolCall",
          id: "p1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
    },
  }),
  line({
    type: "message",
    message: { role: "toolResult", toolCallId: "p1", content: "body" },
  }),
  line({
    type: "message",
    message: { role: "assistant", content: LAST_ANSWER },
  }),
];

/** 一长串 Claude 形状的记录：`message <n> yyyy…`，用来验分页（超过一页 32 KB）。 */
export function longClaudeLines(count, width = 500) {
  return Array.from({ length: count }, (_, index) =>
    line({
      type: index % 2 === 0 ? "user" : "assistant",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${"y".repeat(width)}`,
      },
    }),
  );
}

/** 在 `xdg` 下建 OpenCode 的库（`<xdg>/opencode/opencode.db`），返回 `add`。 */
export function openCodeDatabase(xdg, sessionId) {
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  const path = join(xdg, "opencode", "opencode.db");
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
  );
  database.close();
  return {
    path,
    add(id, at, role, text) {
      const open = new DatabaseSync(path);
      try {
        open.exec("PRAGMA busy_timeout = 5000");
        open
          .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
          .run(id, sessionId, at, at, JSON.stringify({ role }));
        open
          .prepare("INSERT INTO part VALUES (?, ?, ?, 0, 0, ?)")
          .run(
            `p_${id}`,
            id,
            sessionId,
            JSON.stringify({ type: "text", text }),
          );
      } finally {
        open.close();
      }
    },
  };
}

export function writeLines(path, lines) {
  writeFileSync(path, lines.join(""));
  return path;
}
