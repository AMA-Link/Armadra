// 干跑自检（`--dry-run` 与 windows-acceptance.test.mjs 共用）。
// 从 windows-acceptance-lib.mjs 拆出（#573 第 4 项）；lib 重新导出，导入方不用改。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import {
  diffSnapshots,
  launchLine,
  markerLine,
  newResult,
  parseArgs,
  probeLaunchConfig,
  snapshot,
  summarize,
  userConfigTargets,
  validateResult,
} from "./windows-acceptance-lib.mjs";

import {
  HOST_DA1,
  PROBE_DA1,
  answerSources,
  hostAnswerVerdict,
  lastTick,
  receivedInputs,
  replayVerdict,
} from "./windows-acceptance-replies.mjs";

/* --------------------------------- dry run --------------------------------- */

export function selfTests() {
  const tests = [];
  const test = (name, run) => {
    try {
      const detail = run();
      tests.push({ name, ok: true, detail: detail ?? null });
    } catch (error) {
      tests.push({ name, ok: false, detail: error.message });
    }
  };
  const equal = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  };
  test("snapshot", () => {
    const root = mkdtempSync(join(os.tmpdir(), "armadra-acceptance-dry-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "model = 'x'\n");
      const targets = userConfigTargets({
        home,
        appData: join(root, "appdata"),
      });
      const first = snapshot(targets);
      equal(diffSnapshots(first, snapshot(targets)), [], "没改时两次快照不同");
      writeFileSync(join(home, ".codex", "config.toml"), "model = 'y'\n");
      mkdirSync(join(root, "appdata", "Armadra"), { recursive: true });
      const changed = diffSnapshots(first, snapshot(targets)).map((row) =>
        basename(row.path),
      );
      equal(changed.sort(), ["Armadra", "config.toml"], "改动没被发现");
      return { targets: targets.length };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("hostAnswers", () => {
    const hex = (text) => Buffer.from(text, "latin1").toString("hex");
    const host = hex(HOST_DA1);
    const conhost = hex("\u001b[?61;4;6;7;14;21;22;23;24;28;32;42c");
    const text = [
      "TICK:1",
      `GOT:3:${host}`,
      `GOT:4:${host}`,
      "TICK:7",
      `GOT:12:${host}`,
      `GOT:13:${host}`,
      `GOT:replay:${conhost}`,
      `GOT:live:${hex(PROBE_DA1)}`,
    ].join("\r\n");
    const inputs = receivedInputs(text);
    equal(
      inputs.map((row) => row.phase),
      [3, 4, 12, 13, "replay", "live"],
      "输入记录",
    );
    equal(lastTick(text), 7, "最后的 TICK");
    equal(
      answerSources(hex(PROBE_DA1 + HOST_DA1)),
      ["probe", "host"],
      "一段里两份应答",
    );
    equal(answerSources("41"), ["unknown"], "认不出的输入");
    const ranges = { before: [3, 4], during: [6, 11], after: [12, 13] };
    const forwarded = hostAnswerVerdict(inputs, ranges, true);
    equal(forwarded.ok, true, "转发时三段判定");
    equal(forwarded.counts.before.host, 2, "头一段宿主的应答");
    equal(
      hostAnswerVerdict(inputs, { ...ranges, during: [3, 4] }, true).ok,
      false,
      "中间一段有应答要判失败",
    );
    equal(
      hostAnswerVerdict(inputs, ranges, false).ok,
      false,
      "控制台自己答时宿主的应答要判失败",
    );
    const byConsole = receivedInputs(
      [3, 4, 7, 8, 12, 13].map((tick) => `GOT:${tick}:${conhost}`).join("\r\n"),
    );
    equal(
      hostAnswerVerdict(byConsole, { ...ranges, during: [7, 8] }, false).ok,
      true,
      "控制台自己答、每格一份",
    );
    equal(
      hostAnswerVerdict(
        [...byConsole, { phase: 7, hex: host }],
        { ...ranges, during: [7, 8] },
        false,
      ).duplicated,
      [7],
      "同一格两份应答",
    );
    const stale = inputs.filter((row) => row.phase === "replay");
    const live = inputs.filter((row) => row.phase === "live");
    equal(
      replayVerdict({ stale: [], live, replayed: true, sawSecond: true }, true)
        .ok,
      true,
      "转发时回放一段",
    );
    equal(
      replayVerdict({ stale, live, replayed: false, sawSecond: true }, false)
        .ok,
      false,
      "控制台自己答时探针的应答到了程序要判失败",
    );
    equal(
      replayVerdict(
        {
          stale,
          live: [{ phase: "live", hex: conhost }],
          replayed: false,
          sawSecond: true,
        },
        false,
      ).ok,
      true,
      "控制台自己答时回放一段",
    );
  });
  test("launchLines", () => {
    const exe = "C:\\data dir\\run\\probe.exe";
    equal(
      launchLine("cmd", exe, ["C:\\node.exe", "c&d"]),
      '"C:\\data dir\\run\\probe.exe" "C:\\node.exe" "c&d"',
      "cmd 行",
    );
    equal(
      launchLine("pwsh", exe, ["it's", "x|y"]),
      "& 'C:\\data dir\\run\\probe.exe' 'it''s' 'x|y'",
      "pwsh 行",
    );
    let refused = false;
    try {
      launchLine("cmd", exe, ["100%"]);
    } catch {
      refused = true;
    }
    equal(refused, true, "带 % 的值没被拒绝");
    for (const dialect of ["cmd", "pwsh", "powershell"]) {
      const line = markerLine(dialect, "ACC-x-OK");
      if (line.includes("ACC-x-OK"))
        throw new Error(`${dialect} 的记号行含完整记号`);
    }
  });
  test("launchConfig", () => {
    const text = probeLaunchConfig({ client: "C:\\x\\armadra-hook.cmd" });
    const lines = text.split("\r\n");
    equal(lines[0], "armadra-launch 1", "首行");
    if (!lines.includes("credential=C:\\x\\armadra-hook.cmd"))
      throw new Error("没有 credential= 行");
    if (lines.some((line) => /[\r\n]/.test(line)))
      throw new Error("值里有换行");
  });
  test("resultShape", () => {
    const result = newResult(parseArgs(["--dry-run"]));
    result.status = summarize(result);
    equal(validateResult(result), [], "空结果的形状");
  });
  test("parseArgs", () => {
    let refused = false;
    try {
      parseArgs(["--installer", "a.exe", "--app", "b.exe"]);
    } catch {
      refused = true;
    }
    equal(refused, true, "--installer 与 --app 同时给没被拒绝");
    equal(
      parseArgs(["--app", "x.exe", "--soak-minutes", "2"]).soakMinutes,
      2,
      "保活时长",
    );
  });
  return tests;
}
