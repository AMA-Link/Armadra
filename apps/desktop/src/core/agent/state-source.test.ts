import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENT_STATE_SOURCES as SHARED_SOURCES,
  REPORTED_STATE_SOURCES,
  RUN_REPORT_STATE_SOURCES,
} from "@armadra/shared";

import { AGENT_STATE_SOURCES as STORE_SOURCES } from "../hook/store";
import {
  AGENT_STATE_SOURCES,
  OBSERVED,
  STATE_SOURCE_ACP,
  STATE_SOURCE_EXTENSION,
  STATE_SOURCE_HOOK,
  STATE_SOURCE_TRANSCRIPT,
  stateSourceFor,
  stateSourceIsObserved,
  stateSourceIsReported,
  stateSourceIsRunReport,
} from "./state-source";
import { stateSourceIsReported as fromTargetState } from "./target-state";
import {
  AGENT_STATE_SOURCES as FROM_REGISTRY,
  stateSourceIsReported as fromRegistry,
} from "./registry";

describe("状态来源的词汇表", () => {
  it("core、registry、store 与共享层是同一份", () => {
    expect([...AGENT_STATE_SOURCES]).toEqual([...SHARED_SOURCES]);
    expect(FROM_REGISTRY).toBe(AGENT_STATE_SOURCES);
    expect(STORE_SOURCES).toBe(AGENT_STATE_SOURCES);
    expect(fromRegistry).toBe(stateSourceIsReported);
    expect(fromTargetState).toBe(stateSourceIsReported);
  });

  it("每个来源恰好属于上报级或观察级，新增来源必须表态", () => {
    for (const source of AGENT_STATE_SOURCES) {
      expect(
        stateSourceIsReported(source) !== stateSourceIsObserved(source),
        `来源 ${source} 既不是上报级也不是观察级（或两者都是）`,
      ).toBe(true);
    }
    expect([...REPORTED_STATE_SOURCES].sort()).toEqual(
      [
        STATE_SOURCE_ACP,
        STATE_SOURCE_EXTENSION,
        STATE_SOURCE_HOOK,
        STATE_SOURCE_TRANSCRIPT,
      ].sort(),
    );
    expect(stateSourceIsObserved(OBSERVED)).toBe(true);
  });

  it("运行关联报告只收 hook 与 extension，且都是上报级", () => {
    expect([...RUN_REPORT_STATE_SOURCES]).toEqual(["hook", "extension"]);
    for (const source of RUN_REPORT_STATE_SOURCES) {
      expect(stateSourceIsReported(source)).toBe(true);
    }
    expect(stateSourceIsRunReport("acp")).toBe(false);
    // 会话文件来源没有 promptHash 与终端绑定，进不了运行关联报告（契约 §121）。
    expect(stateSourceIsRunReport("transcript")).toBe(false);
    expect(stateSourceIsRunReport(undefined)).toBe(false);
  });

  it("空、未知与 observed 都不算上报", () => {
    for (const value of [undefined, null, "", "observed", "transcript?"]) {
      expect(stateSourceIsReported(value)).toBe(false);
    }
  });

  it("provider 的通道取自表，不取自请求", () => {
    expect(stateSourceFor("claude")).toBe(STATE_SOURCE_HOOK);
    expect(stateSourceFor("pi")).toBe(STATE_SOURCE_EXTENSION);
    expect(stateSourceFor("grok")).toBe(STATE_SOURCE_TRANSCRIPT);
    expect(stateSourceFor("custom:x")).toBeUndefined();
    // agy has no status source yet: its terminal state is OSC 7501, display only.
    expect(stateSourceFor("agy")).toBeUndefined();
  });
});

/* ---------------------------------- 守卫 ---------------------------------- */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const SCANNED = [
  join(ROOT, "apps", "desktop", "src", "core"),
  join(ROOT, "apps", "web", "src"),
  join(ROOT, "packages", "shared", "src"),
];
/** 这两个文件是词汇表的出处，字面量只许在这里。 */
const ALLOWED = new Set(
  [
    join("packages", "shared", "src", "domain", "primitives.ts"),
    join("apps", "desktop", "src", "core", "agent", "state-source.ts"),
  ].map((path) => path.split(sep).join("/")),
);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield path;
    }
  }
}

/** 手写「来源 === 字面量」或字面量数组的写法。 */
const HAND_ROLLED: readonly RegExp[] = [
  /stateSource\s*[!=]==?\s*["'`](hook|extension|acp|observed)["'`]/,
  /["'`](hook|extension|acp|observed)["'`]\s*[!=]==?\s*[\w.?]*stateSource/,
  /\[\s*["'](hook|extension)["']\s*,\s*["'](extension|acp|hook)["']/,
  /new Set\(\[\s*["']hook["']/,
];

describe("守卫：不许手写「是否上报」", () => {
  it("来源字面量只出现在词汇表的出处", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sources(dir)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        text.split("\n").forEach((line, index) => {
          if (HAND_ROLLED.some((pattern) => pattern.test(line))) {
            offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
          }
        });
      }
    }
    expect(
      offenders,
      "改用 `stateSourceIsReported` / `stateSourceIsRunReport` / `stateSourceIsObserved`",
    ).toEqual([]);
  });

  it("规则确实认得出旧写法", () => {
    for (const line of [
      'status.stateSource === "extension" ||',
      'if (facts.stateSource !== "hook" &&',
      '!["hook", "extension"].includes(event.stateSource ?? "")',
      'const REPORTED = new Set(["hook", "extension", "acp"]);',
    ]) {
      expect(
        HAND_ROLLED.some((pattern) => pattern.test(line)),
        line,
      ).toBe(true);
    }
  });
});
