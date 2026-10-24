// 场景：两个页面同时看同一个终端，程序的终端查询只被回答一次（#518）。
//
// 每个 xterm 都会回答 DA1 / DA2 / CPR。以前几个视图就有几份应答进输入，多出
// 来的成了命令行里的 `c1;2c0;276;0c`（2026-10-24 A 档端到端里一张没关的手机
// 页面造成过）。这里两台「设备」各开一个页面看同一块画布上的同一个终端：
//
//  1. 在第一个页面里发查询，关掉回显读一秒内收到的全部输入，只留下应答的
//     终止符：DA1、DA2 各一个 `c`，CPR 一个 `R`，即 `ccR`；
//  2. 换第二个页面打字（它成了驾驶的那一端），再查一次，还是 `ccR`；
//  3. 两个页面的屏幕上都没有混进来的应答碎片，下一条命令照常执行；
//  4. 第二个页面附着的那几秒里，终端里的程序一个字节都没收到：tmux 在新客户端
//     附着时问它 DA 与颜色，应答必须写回被问的那个客户端，写错了客户端就会
//     变成敲进 pane 的键；
//  5. 最近打字的第一个页面敲下一条三秒后才发查询的命令就被冻结（等同手机后台
//     JS 挂起、离屏延迟写屏），第二个页面只看不打字：查询发出时「最近打字的
//     视图」不出声，第二个页面照样答上、只答一份；解冻后第一个页面积压的应答
//     被丢弃，不漏进输入。
//
// tmux 与 direct 各跑一遍：tmux 下 pane 里的查询由 tmux 自己答，xterm 答的是
// tmux 问各个客户端的那几句（应答要回到被问的客户端）；direct 只有一个 pty，
// 应答只能收一份。direct 那一遍改 `worker-settings.json` 并重启 core，跑完改回。
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeNode, sleep } from "./harness.mjs";

const nodeQuery = (id) =>
  `document.querySelector('.react-flow__node[data-id="${id}"]')`;

/** 终端屏幕上的文字（表达式）。 */
const rowsText = (id) =>
  `(${nodeQuery(id)}?.querySelector(".xterm-rows")?.innerText ?? "")`;

/**
 * 关回显、非规范模式，发三个查询，等一秒让每个视图的应答都到齐，一次读空输入，
 * 只留终止符。`stty -echo` 之后应答不上屏，读到的就是 pty 收到的全部。
 */
const QUERY = [
  "stty -echo -icanon min 0 time 5",
  "printf '\\033[c\\033[>c\\033[6n'",
  "sleep 1",
  "R=$(dd bs=4096 count=1 2>/dev/null | tr -cd 'cR')",
  "stty sane",
  'echo "replies-$1=[$R]"',
].join("; ");

/** 一份应答混进命令行的样子：ESC 被 shell 吞掉后剩下的参数与终止符。 */
const LEAKED = /\d;\d+c|\d+;\d+;\d+c|\[\?1;2c|\d+;\d+R/;

/** 读窗口：睡十秒后读空这期间 pty 收到的全部输入，报字节数。 */
const WATCH = [
  "stty -echo -icanon min 0 time 5",
  "sleep 10",
  "N=$(dd bs=4096 count=1 2>/dev/null | wc -c | tr -d ' ')",
  "stty sane",
  'echo "watched-$1=[$N]"',
].join("; ");

async function attachedPage(stack, workspace, board, terminal) {
  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(stack.boardUrl(workspace.id, board.id));
  await page.settle();
  await page.until(
    `return ${nodeQuery(terminal.id)}?.querySelector(".xterm-screen") ? true : null;`,
    "终端挂上 xterm",
    { timeout: 30_000 },
  );
  return page;
}

async function focusTerminal(page, terminal) {
  const screen = await page.until(
    `const element = ${nodeQuery(terminal.id)}?.querySelector(".xterm-screen");
     if (!element) return null;
     const r = element.getBoundingClientRect();
     return { left: r.left, top: r.top };`,
    "终端屏幕",
  );
  await page.click(screen.left + 40, screen.top + 20);
}

/** 在 `page` 里敲一行查询命令；`delay` 秒后才真正发查询。 */
async function typeQuery(page, terminal, round, delay = 0) {
  await focusTerminal(page, terminal);
  // `set --` 把轮次放进 `$1`：屏幕上的回答与这一行命令本身区分得开。
  await page.type(
    `set -- ${round}; ${delay > 0 ? `sleep ${delay}; ` : ""}${QUERY}`,
  );
  await page.key("Enter");
}

/** 在 `page` 的屏幕上等第 `round` 轮的回答。 */
function answerOn(page, terminal, round) {
  return page.until(
    `const text = ${rowsText(terminal.id)}.replace(/\\s+/g, "");
     const found = text.match(/replies-${round}=\\[([cR]*)\\]/);
     return found ? found[1] : null;`,
    `第 ${round} 轮查询的回答`,
    { timeout: 20_000 },
  );
}

async function runOn(page, terminal, round) {
  await typeQuery(page, terminal, round);
  return answerOn(page, terminal, round);
}

async function oneBackend({ stack, output, report, scenario }, backend) {
  const run = scenario(
    report,
    `两个页面同看一个终端，查询只答一次（#518，${backend}）`,
    output,
  );
  // 本机那一半设置（`settings/store.ts`）：别的场景可能已经写过，原样记下、跑完还原。
  const settings = join(stack.data, "worker-settings.json");
  const before = existsSync(settings) ? readFileSync(settings, "utf8") : null;
  if (backend === "direct") {
    const current = before === null ? {} : JSON.parse(before);
    writeFileSync(
      settings,
      JSON.stringify({
        ...current,
        terminal: { ...(current.terminal ?? {}), backend: "direct" },
      }),
    );
    await stack.killCore();
    await stack.startCore();
  }
  const pages = [];
  try {
    const effective = await stack.api("/api/terminals/backend");
    run.check(
      effective.effective === backend,
      `生效的后端是 ${backend}`,
      effective,
    );

    const { workspace, board } = await stack.workspace(
      `查询应答 ${backend}`,
      stack.scratch,
    );
    const terminal = makeNode(
      board.id,
      "terminal",
      "应答",
      { x: 120, y: 120 },
      { width: 560, height: 300 },
      { kind: "terminal" },
    );
    await stack.seedBoard(workspace.id, board.id, [terminal]);

    const desk = await attachedPage(stack, workspace, board, terminal);
    pages.push(desk);
    // 第一个页面先起好 shell（会话由它建），第二个页面再附着同一个会话。
    await focusTerminal(desk, terminal);
    await desk.type("echo first-$((20+1))");
    await desk.key("Enter");
    await desk.until(
      `return ${rowsText(terminal.id)}.includes("first-21") ? true : null;`,
      "第一个页面的 shell 起来了",
      { timeout: 20_000 },
    );
    // 第二个页面附着的那几秒里，终端里的程序什么都不该收到。
    await focusTerminal(desk, terminal);
    await desk.type(`set -- 0; ${WATCH}`);
    await desk.key("Enter");
    await sleep(500);
    const phone = await attachedPage(stack, workspace, board, terminal);
    pages.push(phone);
    // tmux 在新客户端附着时问它 DA 与颜色：等这几句问答走完。
    await sleep(1500);
    const watched = await desk.until(
      `const found = ${rowsText(terminal.id)}.replace(/\\s+/g, "").match(/watched-0=\\[(\\d+)\\]/);
       return found ? found[1] : null;`,
      "附着窗口的读数",
      { timeout: 30_000 },
    );
    run.check(
      watched === "0",
      backend === "tmux"
        ? "第二个页面附着时 tmux 的提问由被问的客户端自己收下，pane 里没有多出输入"
        : "第二个页面附着时终端里没有多出输入",
      `收到 ${watched} 字节`,
    );

    const first = await runOn(desk, terminal, 1);
    run.check(first === "ccR", "第一个页面发查询：DA1、DA2、CPR 各一份", first);

    const second = await runOn(phone, terminal, 2);
    run.check(second === "ccR", "换第二个页面打字后再查：仍然各一份", second);

    await focusTerminal(desk, terminal);
    await desk.type("echo clean-$((40+2))");
    await desk.key("Enter");
    await desk.until(
      `return ${rowsText(terminal.id)}.includes("clean-42") ? true : null;`,
      "下一条命令照常执行",
      { timeout: 20_000 },
    );
    for (const [name, page] of [
      ["第一个页面", desk],
      ["第二个页面", phone],
    ]) {
      const text = await page.evaluate(`return ${rowsText(terminal.id)};`);
      const lines = text
        .split("\n")
        .filter((line) => !line.includes("replies-") && line.trim() !== "");
      const leaked = lines.filter((line) => LEAKED.test(line));
      run.check(
        leaked.length === 0 && !/command not found|not found/.test(text),
        `${name}的屏幕上没有混进来的应答碎片`,
        leaked.length === 0 ? "" : leaked.join(" | "),
      );
    }

    // 最近打字的是第一个页面：它敲下一条三秒后才发查询的命令，随即被冻住；
    // 第二个页面只看不打字。查询发出时「最近打字的视图」不出声。
    await typeQuery(desk, terminal, 3, 3);
    await desk.call("Page.setWebLifecycleState", { state: "frozen" });
    const away = await answerOn(phone, terminal, 3);
    run.check(
      away === "ccR",
      "最近打字的第一个页面被冻结时，只看着的第二个页面仍答上了查询（一份）",
      away,
    );
    await desk.call("Page.setWebLifecycleState", { state: "active" });
    // 积压的消息此刻才处理，迟到的应答都在这几秒里发出来。
    await sleep(4000);
    const back = await runOn(phone, terminal, 4);
    run.check(
      back === "ccR",
      "解冻后第一个页面积压的应答没有漏进输入，再查仍是各一份",
      back,
    );

    const text = await phone.evaluate(`return ${rowsText(terminal.id)};`);
    const leaked = text
      .split("\n")
      .filter((line) => !line.includes("replies-") && LEAKED.test(line));
    run.check(
      leaked.length === 0,
      "解冻后第一个页面迟到的应答被丢弃，没有漏进第二个页面的屏幕",
      leaked.join(" | "),
    );
    // 第三个页面晚到：它附着时拿到的快照 / 回放里带着前几轮的旧查询，不该
    // 被当成新查询；之后真实的查询仍只答一份，它的屏幕上也没有旧应答碎片。
    const late = await attachedPage(stack, workspace, board, terminal);
    pages.push(late);
    await sleep(1500);
    // 晚到页面的 DOM 行文字不一定刷新，结果改写进文件再读。
    const lateFile = join(stack.scratch, `late-replies-${backend}.txt`);
    rmSync(lateFile, { force: true });
    await focusTerminal(late, terminal);
    await late.type(`set -- 5; ${QUERY}; printf %s "$R" > '${lateFile}'`);
    await late.key("Enter");
    let lateRound = "";
    for (let attempt = 0; attempt < 100 && lateRound === ""; attempt += 1) {
      await sleep(200);
      if (existsSync(lateFile)) lateRound = readFileSync(lateFile, "utf8");
    }
    run.check(
      lateRound === "ccR",
      "晚到的第三个页面附着后，真实查询仍各一份",
      lateRound,
    );

    await run.shot(desk, `terminal-replies-${backend}`);
    run.consoleClean(desk);
    run.consoleClean(phone);
    run.entry.status = "passed";
  } finally {
    // 页面不管成败都关掉：留着的手机页会把应答碎片混进后面场景的命令行。
    for (const page of pages) await page.close().catch(() => {});
    if (backend === "direct") {
      if (before === null) rmSync(settings, { force: true });
      else writeFileSync(settings, before);
      await stack.killCore();
      await stack.startCore();
    }
  }
}

export default async function terminalReplies(context) {
  for (const backend of ["tmux", "direct"]) await oneBackend(context, backend);
}
