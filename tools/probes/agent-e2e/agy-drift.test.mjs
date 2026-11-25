import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  SNAPSHOT_FILE,
  USED_FLAGS,
  diffSurface,
  initializeShape,
  missingUsedFlags,
  parseFlags,
  parseHookEvents,
  parseSubcommands,
} from "./agy-drift.mjs";

const HELP = `Usage of agy:
  --add-dir                       Add a directory (repeatable) (default [])
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --mode                          Set the agent execution mode
  -i                              Short alias for --prompt-interactive
  --prompt-interactive            Run an initial prompt interactively

Available subcommands:
  acp             Start the ACP stdio server
  plugin          Manage plugins
  update          Update CLI
`;

test("旗标与子命令从 --help 里读出来，短别名不算", () => {
  assert.deepEqual(parseFlags(HELP), [
    "--add-dir",
    "--continue",
    "--mode",
    "--prompt-interactive",
  ]);
  assert.deepEqual(parseSubcommands(HELP), ["acp", "plugin", "update"]);
});

test("hook 事件集取自 validate 的警告", () => {
  const report =
    '⚠ hooks.json: hook "x": unknown event "Notification" is ignored (events: SessionStart, PreInvocation, Stop)';
  assert.deepEqual(parseHookEvents(report), [
    "PreInvocation",
    "SessionStart",
    "Stop",
  ]);
  assert.deepEqual(parseHookEvents("Validation passed"), []);
});

test("initialize 只留 Armadra 读的形状，不带账号信息", () => {
  const shape = initializeShape({
    protocolVersion: 1,
    agentInfo: { name: "x", version: "9" },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, load: {} },
      promptCapabilities: { image: true },
      _meta: { antigravity: { systemPrompt: { append: true }, tier: true } },
    },
    authMethods: [{ id: "b", name: "n" }, { id: "a" }],
  });
  assert.deepEqual(shape, {
    protocolVersion: 1,
    loadSession: true,
    sessionCapabilities: ["load", "resume"],
    promptCapabilities: ["image"],
    hasMcpCapabilities: false,
    systemPromptAppend: true,
    authMethods: ["a", "b"],
  });
});

test("差异与「用到的旗标没了」分开报告", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  assert.deepEqual(diffSurface(snapshot, snapshot), []);
  const drifted = {
    ...snapshot,
    hookEvents: [...snapshot.hookEvents, "UserPromptSubmit"],
    mainFlags: snapshot.mainFlags.filter((flag) => flag !== "--settings"),
    initialize: { ...snapshot.initialize, hasMcpCapabilities: true },
  };
  const lines = diffSurface(snapshot, drifted);
  assert.ok(
    lines.some((line) => /hook 事件：多了 UserPromptSubmit/.test(line)),
  );
  assert.ok(lines.some((line) => /主程序旗标：少了 --settings/.test(line)));
  assert.ok(lines.some((line) => /initialize\.hasMcpCapabilities/.test(line)));
  assert.deepEqual(missingUsedFlags(drifted), ["--settings"]);
  assert.deepEqual(missingUsedFlags(snapshot), []);
});

test("快照里的旗标覆盖我们用到的每一个", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  for (const flag of USED_FLAGS.main)
    assert.ok(snapshot.mainFlags.includes(flag), flag);
  for (const flag of USED_FLAGS.acp)
    assert.ok(snapshot.acpFlags.includes(flag), flag);
  // 原生 hook 只认这六个事件（UserPromptSubmit / Notification 不在其中）。
  assert.deepEqual(snapshot.hookEvents, [
    "PostInvocation",
    "PostToolUse",
    "PreInvocation",
    "PreToolUse",
    "SessionStart",
    "Stop",
  ]);
});
