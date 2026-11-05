// 会话宿主代答（DA1 / DSR）的探针段：终端里的查询脚本、三方应答的判定与 `sessionHostReplies`。
// 从 windows-acceptance-lib.mjs 拆出（#573 第 4 项）；lib 重新导出，导入方不用改。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * 会话宿主代答验收的被测程序（#565）：往终端里发查询，把收到的每一段输入原样记成
 * `GOT:<阶段>:<十六进制>`，所以「谁答了查询」读 capture 就知道。
 *
 *   * `replay`：先发一次 DA1（`ESC [ c`）和 `REPLAYSENT`，6 秒后再发一次 DA1 和
 *     `SECONDQUERY`，此后的输入记在阶段 `live` 下，之前的记在 `replay` 下；
 *   * `loop`：每秒发一次 DA1 和 `TICK:<n>`，输入记在当时的 n 下。用 DA1 而不是 DSR 5n：
 *     三方对 DA1 的应答字节各不相同（{@link PROBE_DA1}、{@link HOST_DA1}、控制台自己的），
 *     读输入就分得出是谁答的。
 */
export const QUERY_SCRIPT = [
  "const mode = process.argv[2];",
  "let phase = mode === 'replay' ? 'replay' : 0;",
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  "process.stdin.resume();",
  "process.stdin.on('data', (chunk) => process.stdout.write('\\r\\nGOT:' + phase + ':' + chunk.toString('hex') + '\\r\\n'));",
  "if (mode === 'replay') {",
  "  process.stdout.write('\\x1b[c\\r\\nREPLAYSENT\\r\\n');",
  "  setTimeout(() => { phase = 'live'; process.stdout.write('\\x1b[c\\r\\nSECONDQUERY\\r\\n'); }, 6000);",
  "  setTimeout(() => process.exit(0), 40000);",
  "} else {",
  "  const timer = setInterval(() => {",
  "    phase += 1;",
  "    process.stdout.write('\\x1b[c\\r\\nTICK:' + phase + '\\r\\n');",
  "    if (phase >= 90) { clearInterval(timer); process.exit(0); }",
  "  }, 1000);",
  "}",
].join("\n");

/** 探针扮演的页面终端对 DA1 的应答（只在探针决定时发）。 */
export const PROBE_DA1 = "\u001b[?1;2c";
/** 会话宿主代答 DA1 的字节（`session-host/replay.ts` 的 `answerFor`）。 */
export const HOST_DA1 = "\u001b[?1;0c";

/** capture 文本里程序记下的输入：`{ phase, hex }`。 */
export function receivedInputs(text) {
  return [...String(text).matchAll(/GOT:(\w+):([0-9a-f]+)/g)].map((match) => ({
    phase: /^\d+$/.test(match[1]) ? Number(match[1]) : match[1],
    hex: match[2],
  }));
}

/**
 * 一段输入里的 DA1 应答各是谁发的：`probe`、`host`，其余的 DA1 应答是 `console`
 * （ConPTY 背后的控制台自己答的）；一段里认不出 DA1 应答就记一个 `unknown`。
 */
export function answerSources(hex) {
  const text = Buffer.from(hex, "hex").toString("latin1");
  // eslint-disable-next-line no-control-regex -- 匹配 ANSI 转义序列，必须写出控制字符
  const found = [...text.matchAll(/\u001b\[\?[0-9;]*c/g)].map(([answer]) =>
    answer === PROBE_DA1 ? "probe" : answer === HOST_DA1 ? "host" : "console",
  );
  return found.length > 0 ? found : ["unknown"];
}

/** 一组输入里按来源计数。 */
export function countSources(inputs) {
  const counts = { probe: 0, host: 0, console: 0, unknown: 0 };
  for (const row of inputs)
    for (const source of answerSources(row.hex)) counts[source] += 1;
  return counts;
}

/** 程序打到第几个 TICK 了。 */
export function lastTick(text) {
  let last = 0;
  for (const match of String(text).matchAll(/TICK:(\d+)/g))
    last = Math.max(last, Number(match[1]));
  return last;
}

/**
 * 宿主代答三段的判定：`inputs` 是 `receivedInputs` 的结果，三个区间都是 [from, to]
 * 的 TICK 号（两头已经留出附着与断开的时延）。每个 TICK 至多一份应答（多了就是重复
 * 输入，#518）。`forwarded` 是 ConPTY 有没有把查询转给外面：
 *
 *   * 转了：没有可写附着的头尾两段每个 TICK 都该有一份宿主的应答；有可写附着（而它
 *     不答）的中间一段一份都不该有；
 *   * 没转（控制台自己答了，宿主与页面都看不到查询）：三段都是每个 TICK 一份控制台的
 *     应答，宿主一份都不该答。
 */
export function hostAnswerVerdict(
  inputs,
  { before, during, after },
  forwarded,
) {
  const ticks = inputs.filter((row) => typeof row.phase === "number");
  const within = ([from, to]) =>
    ticks.filter((row) => row.phase >= from && row.phase <= to);
  const counts = {
    before: countSources(within(before)),
    during: countSources(within(during)),
    after: countSources(within(after)),
  };
  const perTick = new Map();
  for (const row of ticks)
    perTick.set(
      row.phase,
      (perTick.get(row.phase) ?? 0) + answerSources(row.hex).length,
    );
  const duplicated = [...perTick]
    .filter(([, count]) => count > 1)
    .map(([tick]) => tick);
  const span = (range) => range[1] - range[0] + 1;
  const total = (phase) =>
    Object.values(counts[phase]).reduce((sum, count) => sum + count, 0);
  const full = (phase, source) =>
    counts[phase][source] >= span({ before, during, after }[phase]) - 1;
  const ok =
    duplicated.length === 0 &&
    (forwarded
      ? full("before", "host") && total("during") === 0 && full("after", "host")
      : ["before", "during", "after"].every(
          (phase) => full(phase, "console") && counts[phase].host === 0,
        ));
  return { ok, counts, duplicated };
}

/**
 * 回放一段的判定（`stale` / `live` 是阶段 `replay` / `live` 的输入）。两种情形都要求：
 * 探针替回放里旧查询发的应答不到程序，实时查询只到一份应答。
 *
 *   * ConPTY 转了查询：回放里看得到旧查询；没有人答旧查询（附着着的探针不答，宿主见
 *     可写附着也不答），实时查询的那一份是探针的；
 *   * 没转（控制台自己答）：两次查询各有一份控制台的应答，探针与宿主的都不到。
 */
export function replayVerdict({ stale, live, replayed, sawSecond }, forwarded) {
  const before = countSources(stale);
  const after = countSources(live);
  const sum = (counts) =>
    Object.values(counts).reduce((total, count) => total + count, 0);
  const ok =
    sawSecond &&
    before.probe === 0 &&
    sum(after) === 1 &&
    (forwarded
      ? replayed && sum(before) === 0 && after.probe === 1
      : before.console === 1 && sum(before) === 1 && after.console === 1);
  return { ok, stale: before, live: after };
}

/**
 * `sessionHost.replies`（#565）：见 CHECKS 里的说明与 `QUERY_SCRIPT`。`app` 要有
 * `api`、`terminal`、`evaluate`；长开的附着经页面里的 `watch*` 助手。
 */
export async function sessionHostReplies(record, app, result, dirs) {
  const shell = result.machine.shells.cmd;
  if (!shell) return record.skip("sessionHost.replies", "没有 cmd.exe");
  const work = dirname(dirs.wsDir);
  return await record.check("sessionHost.replies", () =>
    runSessionHostReplies({ app, shell, work, ...dirs }),
  );
}

async function runSessionHostReplies({ app, work, workspaceId, wsDir, shell }) {
  const watch = (action, ...args) =>
    app.evaluate(
      `(globalThis.__acceptance).watch${action}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`,
    );
  const script = join(work, "query-program.js");
  writeFileSync(script, QUERY_SCRIPT);
  const start = async (mode, wanted) => {
    const response = await app.api("POST", "/api/terminals", {
      workspaceId,
      cwd: wsDir,
      shell,
    });
    const id = response.body?.id;
    if (typeof id !== "string") return { error: response };
    const typed = await app.terminal(
      id,
      [`"${process.execPath}" "${script}" ${mode}\r`],
      wanted,
      60_000,
    );
    return { id, typed };
  };
  // capture 读的是 core 按附着收到的字节排出的屏幕（契约 §53）：没人附着时它停在最后
  // 一个附着离开的那一刻。所以下面每次读 capture 都在某个附着开着的时候读。
  const screen = async (id) => {
    const capture = await app.api(
      "GET",
      `/api/terminals/${id}/capture?lines=500`,
    );
    return typeof capture.body?.data === "string" ? capture.body.data : "";
  };
  const finish = (id) =>
    app.api("POST", `/api/terminals/${id}/terminate`, {
      mode: "session",
    });
  const detail = {};
  const sample = (inputs) =>
    [...new Set(inputs.map((row) => row.hex))].slice(0, 4);

  // 一、附着回放里带着查询：回放是过去，视图对它的应答没有人在等，不能变成输入；
  // 随后程序发的实时查询，只放行一份。
  const replay = await start("replay", "REPLAYSENT");
  if (replay.id === undefined) {
    return { ok: false, detail: { replay } };
  }
  const opened = await watch("Open", "late", replay.id);
  await sleep(500);
  const late = await watch("Read", "late");
  const replayed = (late?.seen ?? "").includes("\u001b[c");
  // 回放里那次查询的应答（页面的终端会这么答）：不该到达程序。
  await watch("Send", "late", {
    type: "input",
    data: PROBE_DA1,
    reply: true,
  });
  let sawSecond = false;
  let liveSeen = "";
  for (let waited = 0; waited < 20_000; waited += 250) {
    const now = await watch("Read", "late");
    liveSeen = now?.seen ?? "";
    if (liveSeen.includes("SECONDQUERY")) {
      sawSecond = true;
      break;
    }
    await sleep(250);
  }
  if (sawSecond) {
    // 同一条实时查询两份应答（两个视图都会答）：只该有一份到程序。这里用同一条
    // socket 连发两份，账上第二份已经没有待答查询，必须被丢掉。
    for (let copy = 0; copy < 2; copy += 1) {
      await watch("Send", "late", {
        type: "input",
        data: PROBE_DA1,
        reply: true,
      });
    }
  }
  await sleep(2_000);
  const inputs = receivedInputs(await screen(replay.id));
  await watch("Close", "late");
  await finish(replay.id);
  const stale = inputs.filter((row) => row.phase === "replay");
  const live = inputs.filter((row) => row.phase === "live");
  // ConPTY 把程序的 DA1 转给外面没有：转了的话附着的视图在实时输出里看得到
  // `ESC [ c`。没转就是控制台自己答了，宿主与页面都不会见到这条查询。
  const forwardedReplay = replayed || liveSeen.includes("\u001b[c");
  const replayCheck = replayVerdict(
    { stale, live, replayed, sawSecond },
    forwardedReplay,
  );
  detail.replay = {
    attached: opened?.ok === true,
    queriesForwarded: forwardedReplay,
    replayHadQuery: replayed,
    sawSecondQuery: sawSecond,
    staleAnswers: replayCheck.stale,
    liveAnswers: replayCheck.live,
    inputs: sample([...stale, ...live]),
  };
  const replayOk = opened?.ok === true && replayCheck.ok;

  // 二、宿主代答的切换：没有附着时宿主答；有可写附着（页面的终端负责答，这里它
  // 故意不答）时宿主不答；附着离开后宿主接着答。TICK 号两头各留两格余量。
  const loop = await start("loop", "TICK:1");
  if (loop.id === undefined) {
    detail.replay.ok = replayOk;
    return { ok: false, detail: { ...detail, loop } };
  }
  // 没人附着的这段 capture 不动，读不到 TICK 走到几：按程序每秒一个 TICK 等够，
  // 区间的边界都按附着之后读到的 TICK 号算，不按这里的时长。
  await sleep(8_000);
  const watching = await watch("Open", "quiet", loop.id);
  const attachedAt = lastTick(await screen(loop.id));
  await sleep(6_000);
  const leftAt = lastTick(await screen(loop.id));
  const quietSeen = (await watch("Read", "quiet"))?.seen ?? "";
  await watch("Close", "quiet");
  await sleep(7_000);
  // 再附着一次，capture 换成宿主的整段回放：附着之前的输入都在里面。这次附着本身
  // 也是可写的，所以只看它之前两格的 TICK。
  const reopened = await watch("Open", "after", loop.id);
  const text = await screen(loop.id);
  await watch("Close", "after");
  await finish(loop.id);
  const reattachedAt = lastTick(text);
  const forwardedLoop = quietSeen.includes("\u001b[c");
  const loopInputs = receivedInputs(text);
  const verdict = hostAnswerVerdict(
    loopInputs,
    {
      before: [2, Math.max(2, attachedAt - 2)],
      during: [attachedAt + 2, Math.max(attachedAt + 2, leftAt - 2)],
      after: [leftAt + 2, Math.max(leftAt + 2, reattachedAt - 2)],
    },
    forwardedLoop,
  );
  detail.hostAnswers = {
    attached: watching?.ok === true,
    reattached: reopened?.ok === true,
    queriesForwarded: forwardedLoop,
    attachedAtTick: attachedAt,
    leftAtTick: leftAt,
    reattachedAtTick: reattachedAt,
    counts: verdict.counts,
    duplicated: verdict.duplicated,
    inputs: sample(loopInputs),
  };
  return {
    ok:
      replayOk &&
      watching?.ok === true &&
      reopened?.ok === true &&
      forwardedLoop === forwardedReplay &&
      verdict.ok,
    detail,
  };
}
