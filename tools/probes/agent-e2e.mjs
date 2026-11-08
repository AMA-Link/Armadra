// Agent 协作端到端探针：真 Claude Code、真 Codex CLI、真 core、真页面。
//
// 为什么页面必须挂着：CLI 起来时向终端发一串查询（光标位置、设备属性、键盘协
// 议、前景 / 背景色），xterm 的应答经页面的输入通道写回 PTY。2026-09-25 那次
// 「Codex 首条任务永远投不出去」（状态文档 §31.7）就是这些应答被当成了半截输
// 入——只有页面真的挂着这些终端节点时才会出现。所以这里每个 Agent 节点都由页
// 面挂载、由页面敲启动行，与用户点出来的节点走同一条路。
//
// 场景（每个都截图、收集控制台错误）：
//   1. Codex 首投：普通终端节点当发送方，`canvas send` 投给两个新建的 Codex，
//      再用 `open-agent --task` 建第三个；断言 delivered + observed-quiet，且
//      Codex 真的开始了一轮（hook 报了 working / idle）。
//   2. Claude 投递：hook 状态通道那条路，外加半截输入门（打半行不回车 →
//      TARGET_INPUT_PENDING 排队，回车之后投出去）。
//   3. 依赖编排与组队：`open-agent --after … --after-turn next`、
//      `team --member … --chain`；关掉页面再触发一次。
//   4. 节能休眠：秒级阈值（`ARMADRA_TEST_ECO_IDLE_SECONDS`，见
//      `core/terminal/hibernate.ts::ecoTestOverride`），进程确实退出，聚焦节点唤
//      醒后 resume 同一个会话、还记得之前说过的话。Claude 与 Codex 各一遍。
//   5. 画布内注入：同样的环境，只差启动行上的注入参数——画布外启动的 Codex /
//      Claude 看不到画布说明与我们的技能、Hook 不打到 core；带上注入参数后都生效。
//   6. 组队带 worktree：`team --member "…|worktree=名字"` 建出检出与绑定的
//      Frame，成员的终端起在检出里。用假 CLI、自己一套 core，`--only 6` 单跑
//      时不需要真 CLI 的登录。
//   11. 协调者 ama（设计 coordinator-agent §8 第 1–4 步）：本地脚本化模型服务驱动
//      随包的 ama，`canvas_team` 起两个成员、收件箱唤醒、`inbox → ack → sticky`
//      写汇总。和场景 9 一样自己起一套 core，不要真模型、不要真密钥。
//   12. 六家 ACP（设计 acp-session-view §11）：六家各起一个 ACP 驱动的节点，各两轮
//      「回复 OK」，Claude 的审批经页面拒绝、切到终端视图再切回、OpenCode 休眠
//      再唤醒、沿环 send 与下游读上游。每家的 ACP 入口经一个隔离包装脚本起（临
//      时 HOME / 配置目录、只复制凭据），没装的记 skipped。`--self-test` 把六家
//      换成假 ACP Agent 与假 TUI，证明探针本身。
//   13. 时间线一致性（设计 acp-progressive-view B10）：同一条会话时间线，ACP 与终端
//      两种驱动轮流写，两台设备同时看（一台中途掉线重连），core 重启后比对条目、
//      `rev` 与 head_seq 一致、帧首尾相接。真跑家族取 claude、codex；`--self-test`
//      用假 ACP Agent 与假 TUI。
//   14. 分派基准（#704）：协调者（真模型）带两个脚本化成员，固定事件流（做好了、受阻
//      带问题、人的追问、交回），`default` 与 `coordinator` 两种预设各 N 次，记完成
//      时间与 token，断言不自己执行、对人说话只走 `notify` 且内容对。只在
//      `--only 14` 时跑；缺 `ARMADRA_E2E_REAL=1` 或模型就记 skipped 并写原因。
//      `--self-test` 用脚本化模型走一遍探针本身。
//   15. 协调者主动接单（契约 §104，#830）：本地假 Gitea 出一个 issue → 协调者卡片有
//      `intake` 行 → 脚本化模型 `canvas_intake` 读详情并判定 accept → observe 下不派
//      发 → 人经 HTTP 切 auto 并确认规则 → `canvas_open_agent {candidate}`，工作项
//      `mandate.basis = rule`、issue 线程已绑 → 假 forge 加评论 → 成员收到原文、协
//      调者只多一行 `external`。自己起 core，不要登录与真模型；等 60 / 120 秒定时器，
//      约 4–6 分钟，只在 `--only 15` 时跑。
//   16. 对话交接 v2（#872）：见 agent-e2e/scenario-16-handoff.mjs；`--only 16` 单跑，假 ACP Agent
//      与夹具转录，不要登录与真模型。
//   17. 终端 OpenCode 的画布审批（#857）：见 agent-e2e/scenario-17-opencode-approval.mjs；
//      `--only 17` 单跑，要 ARMADRA_E2E_REAL=1，真 OpenCode、免费模型。
//   10. 六家互读（设计 cli-collaboration §8）：六种 CLI 各起一个交互式 TUI 节点
//      连成环，下游 `context summary / transcript` 读上游、沿环 send、拒收一条
//      排队看回执、交接 prepare → accept、会话索引与成本每家都有。没装或认证
//      不上的那家记 skipped。
//
// 认证与隔离：
//   * Codex 用临时 CODEX_HOME，只**复制** ~/.codex/auth.json 进去。token 超过 7
//     天没刷新就不跑——在临时目录里刷新会轮换 refresh token，真实那份随之失效。
//   * Claude 的登录在钥匙串里，临时 CLAUDE_CONFIG_DIR 认证不上，所以 Claude 进程
//     用真实的配置目录。前提是 Armadra 对 Claude 走启动时注入（`--settings` 指
//     向数据目录里的文件，`core/hook/install/claude.ts`），不写 ~/.claude/
//     settings.json。core 自己的 CLAUDE_CONFIG_DIR 仍指向临时目录：安装时的技能
//     文件与「清理旧条目」只落在临时目录里。终端子进程的环境是按白名单建的，
//     CODEX_HOME 带不进去，于是 SHELL 换成一个临时包装脚本：导出临时
//     CODEX_HOME、去掉 CLAUDE_CONFIG_DIR，再 `exec zsh -f`（不读用户的 rc）。
//   * 跑前跑后比对 ~/.claude/settings.json、~/.codex 的 config.toml / hooks.json /
//     auth.json 的字节，有变化就判失败。
//   * 端口随机，数据目录、工作空间、浏览器 profile 全部 mktemp，结束时删掉并停掉
//     自己起的 tmux 服务器。
//
// C 档开关：起真 CLI、花真额度的场景（1–8、10、11 的 `--real-model`、12）只在
// `ARMADRA_E2E_REAL=1` 时跑，否则在起任何进程之前退出；9、11（脚本化模型）与
// `--self-test` 不要它。运行手册（要装什么、登录什么、花多少）见
// tools/probes/README.md「C 档运行手册」。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/agent-e2e.mjs [输出目录] [--only 1,2,…,13] [--backend direct]
//        [--self-test] [--real-model] [--record-compat]
//
// 产物：<输出目录>/result.json、每个场景的截图、core.log。
import {
  fingerprint,
  scenario,
  finalize,
  only,
  preflight,
  setupOnly,
  REAL_FLAG,
  realAllowed,
  realModel,
  report,
  selfTest,
  setup,
  state,
} from "./agent-e2e/lib.mjs";
import scenario1 from "./agent-e2e/scenario-1-codex-first-delivery.mjs";
import scenario2 from "./agent-e2e/scenario-2-claude-delivery.mjs";
import scenario3 from "./agent-e2e/scenario-3-dependencies-team.mjs";
import scenario4 from "./agent-e2e/scenario-4-eco-hibernate.mjs";
import scenario5 from "./agent-e2e/scenario-5-canvas-only.mjs";
import scenario6 from "./agent-e2e/scenario-6-other-clis.mjs";
import scenario7 from "./agent-e2e/scenario-7-claude-approval.mjs";
import scenario8 from "./agent-e2e/scenario-8-send-wakes.mjs";
import scenario9 from "./agent-e2e/scenario-9-team-worktree.mjs";
import scenario10 from "./agent-e2e/scenario-10-six-way-context.mjs";
import scenario11 from "./agent-e2e/scenario-11-coordinator.mjs";
import scenario12 from "./agent-e2e/scenario-12-acp.mjs";
import scenario13 from "./agent-e2e/scenario-13-timeline.mjs";
import scenario14 from "./agent-e2e/scenario-14-dispatch-bench.mjs";
import scenario15 from "./agent-e2e/scenario-15-intake.mjs";
import scenario16 from "./agent-e2e/scenario-16-handoff.mjs";
import scenario17 from "./agent-e2e/scenario-17-opencode-approval.mjs";
import { cliPrerequisites, planScenarios } from "./agent-e2e/preflight.mjs";
import { homedir } from "node:os";

const SCENARIOS = [
  ["1", scenario1],
  ["2", scenario2],
  ["3", scenario3],
  ["4", scenario4],
  ["5", scenario5],
  ["6", scenario6],
  ["7", scenario7],
  ["8", scenario8],
  ["10", scenario10],
];

/** 自己起一套 core 的场景：不走 `setup()`（不要真 CLI 的登录，也不起共用页面）。 */
const STANDALONE = new Set(["9", "11", "12", "13", "14", "15", "16", "17"]);

async function main() {
  // C 档门：要起真 CLI / 真模型的，没设开关就在起任何进程之前退出。
  const shared = [...only].filter((id) => !STANDALONE.has(id));
  const real = [
    ...shared,
    ...(only.has("11") && realModel && !selfTest ? ["11 --real-model"] : []),
    ...(only.has("12") && !selfTest ? ["12"] : []),
    ...(only.has("13") && !selfTest ? ["13"] : []),
    ...(only.has("16") && !selfTest ? ["16"] : []),
    ...(only.has("17") && !selfTest ? ["17"] : []),
  ];
  if (selfTest && shared.length > 0)
    throw new Error(
      `--self-test 只覆盖场景 11 / 12 / 13（9 本来就不要真 CLI）；去掉 ${shared.join("、")}`,
    );
  if (real.length > 0 && !realAllowed)
    throw new Error(
      `场景 ${real.join("、")} 会起真 CLI、用真账号与额度：按 tools/probes/README.md「C 档运行手册」准备好后以 ${REAL_FLAG}=1 运行；只验证探针本身用 --only 11,12 --self-test`,
    );
  report.mode = selfTest ? "self-test" : real.length > 0 ? "real" : "mock";

  // 共用装配要的 Claude / Codex 前提：缺哪家只跳过依赖它的场景，不让装配崩掉。
  // `--preflight` 只答这份计划、不起 core（只跑两家的 `--version`、读 auth.json
  // 的刷新时间）。
  const clis = shared.length > 0 ? cliPrerequisites({ home: homedir() }) : {};
  const plan = planScenarios(
    shared.filter((id) => id !== "6" && id !== "10"),
    clis,
  );
  const sharedRun = [
    ...plan.run,
    ...shared.filter((id) => id === "6" || id === "10"),
  ];
  report.preflight = {
    clis: Object.fromEntries(
      Object.entries(clis).map(([id, entry]) => [
        id,
        entry.ok
          ? { ok: true, version: entry.version }
          : { ok: false, reason: entry.reason },
      ]),
    ),
    run: sharedRun,
    skip: plan.skip,
  };
  if (preflight) {
    report.safety.before ??= fingerprint();
    console.log(JSON.stringify(report.preflight, null, 2));
    report.status = "preflight";
    return;
  }

  // 场景 9 用假 CLI、自己起一套 core：单跑它时不要真 CLI 的登录，也不起页面。
  if (only.has("9")) {
    report.safety.before ??= fingerprint();
    await scenario9();
  }
  // 场景 11 同样自己起一套 core、用脚本化模型：不要登录、不起页面。
  if (only.has("11")) {
    report.safety.before ??= fingerprint();
    await scenario11();
  }
  // 场景 12 自己起 core、页面与六家 ACP 入口的隔离包装。
  if (only.has("12")) {
    report.safety.before ??= fingerprint();
    await scenario12();
  }
  // 场景 13：时间线一致性，自己起 core 与两家的隔离包装。
  if (only.has("13")) {
    report.safety.before ??= fingerprint();
    await scenario13();
  }
  // 场景 14：分派基准（#704），真模型；没有前提就记 skipped，不进 CI。
  if (only.has("14")) {
    report.safety.before ??= fingerprint();
    await scenario14();
  }
  // 场景 15：协调者主动接单（#830），脚本化模型 + 本地假 Gitea；要等定时器，不进缺省。
  if (only.has("15")) {
    report.safety.before ??= fingerprint();
    await scenario15();
  }
  // 场景 16：对话交接 v2（#872），假 ACP Agent 与夹具转录，不要登录、不起页面。
  if (only.has("16")) {
    report.safety.before ??= fingerprint();
    await scenario16();
  }
  // 场景 17：终端 OpenCode 的画布审批（#857），真 OpenCode、免费模型；自己起 core。
  if (only.has("17")) {
    report.safety.before ??= fingerprint();
    await scenario17();
  }
  for (const [id, reason] of Object.entries(plan.skip))
    scenario(id).skip(reason);
  if (sharedRun.length === 0 && !setupOnly) return;
  const ctx = await setup(clis);
  if (setupOnly) {
    const s = scenario("setup-only");
    const titles = ctx.seeded.map((node) => node.title);
    s.check("共用装配走完，core 在跑", ctx.runtime.exitCode === null, titles);
    s.check(
      "只给可用的那几家建节点",
      titles.includes("codex-a") === clis.codex.ok &&
        titles.includes("claude-a") === clis.claude.ok,
      { titles, codex: clis.codex.ok, claude: clis.claude.ok },
    );
    s.finish();
    state.currentScenario = "teardown";
    return;
  }
  for (const [id, run] of SCENARIOS) if (sharedRun.includes(id)) await run(ctx);

  state.currentScenario = "teardown";
  const { page, all, board } = ctx;
  if (page !== undefined) await page.shot("final", undefined);
  report.deliveries = all(
    "SELECT target_node_id, outcome, target_state, receipt, created_at FROM agent_deliveries ORDER BY created_at",
  );
  report.nodes = all(
    "SELECT id, title FROM nodes WHERE board_id = ?",
    board.id,
  );
}

// 被中断也要收尾：不收的话 core、tmux 服务器、Vite 与临时目录都留在机器上。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    report.error = `被 ${signal} 中断`;
    finalize();
  });
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${error?.stack ?? error}`);
} finally {
  finalize();
}
