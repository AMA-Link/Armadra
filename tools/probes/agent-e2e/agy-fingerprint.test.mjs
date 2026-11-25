import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { geminiFingerprint } from "./agy-fingerprint.mjs";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "armadra-agy-fp-"));
  mkdirSync(join(dir, ".gemini", "config", "plugins"), { recursive: true });
  mkdirSync(join(dir, ".gemini", "antigravity-cli", "conversations"), {
    recursive: true,
  });
  writeFileSync(join(dir, ".gemini", "settings.json"), "{}");
  return dir;
}

test("agy 自己写的对话库与日志不改变指纹，用户配置的任何变化都会", () => {
  const dir = home();
  try {
    const before = geminiFingerprint(dir);
    writeFileSync(
      join(dir, ".gemini", "antigravity-cli", "conversations", "a.db"),
      "x",
    );
    assert.deepEqual(geminiFingerprint(dir), before);
    writeFileSync(join(dir, ".gemini", "config", "hooks.json"), "{}");
    assert.notDeepEqual(geminiFingerprint(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("名字里带 armadra 的条目、新插件目录都算我们写过东西", () => {
  const dir = home();
  try {
    const before = geminiFingerprint(dir);
    mkdirSync(join(dir, ".gemini", "config", "plugins", "armadra"));
    const after = geminiFingerprint(dir);
    assert.notDeepEqual(after, before);
    assert.equal(after.armadraNamed.length, 1);
    assert.deepEqual(after.plugins, ["armadra"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没有 ~/.gemini 时是一份全空的指纹", () => {
  const dir = mkdtempSync(join(tmpdir(), "armadra-agy-fp-"));
  try {
    assert.deepEqual(geminiFingerprint(dir), {
      settings: null,
      cliSettings: null,
      mcpConfig: null,
      hooks: null,
      plugins: null,
      armadraNamed: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
