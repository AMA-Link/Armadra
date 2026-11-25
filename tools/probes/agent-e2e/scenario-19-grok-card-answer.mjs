// 场景 19：终端 grok 审批卡在画布里答复（契约 §127，#1027）。
//
// 真 grok 1.0.92（本机装着的那个）加**脚本化模型**（`mock-model.mjs`）：模型只回本脚本
// 排好的工具调用，不连任何真账号、不出本机。自己起一套 core（临时数据目录、临时 HOME、
// 临时 `GROK_HOME`），`agents.grok.answerCards` 开着。主体与正例的节点都是**经 Armadra
// 启动**的：`POST /api/terminals` 带 `launch: true`，core 自己敲出带真旗标的启动行
// （`--permission-mode acceptEdits`），读取槽读的是 grok 进程自己的 argv。
//
// 主体：允许、拒绝各 N 轮（缺省 20，`ARMADRA_E2E_GROK_ROUNDS`）。每一轮：
//   * 模型调一条要审批的命令，读取槽建出审批记录（`blocked` + `pendingId`）；
//   * 经 `POST /api/approvals/<id>/answer` 答，route 是 `keys`、`delivery` 是 `confirmed`；
//   * `events.jsonl` 里那条请求之后的第一条 `permission_resolved` 与所答一致；
//   * 允许：命令真的跑了（文件在）；拒绝：命令没跑（文件不在）；
//   * 审计里 route 是 `keys`、accepted。
// 全部轮次之后：
//   * `GROK_HOME`（除运行时文件）与工程里的 `.grok` 按内容哈希不变——证明从没选到 Always / Never / always-approve；
//   * 对照：允许过的那条命令再来一次，卡片又弹出来（没有被记成规则）。
//
// 负例（每个都要求「没有发键」或「被识别出来」，且审批记录不被答错）：
//   * 提问卡（`ask_user_question`）：不建记录；
//   * 计划审阅（plan 模式 `exit_plan_mode`）：不建记录；
//   * Esc（焦点落到滚动区，页脚不再是选择态）：答复 409，一个键都没发；
//   * `e`（规则编辑态）：答复 409，一个键都没发；这也是「记录建成之后卡变了」；
//   * 并行卡（一条消息里两个工具调用）：grok 逐张出卡，第一张答允许、第二张答拒绝，各自
//     confirmed，第一张的命令跑了、第二张没跑；
//   * 设置关着、缺省模式的进程（节点写着 auto-edit 但 argv 里没有旗标）、版本不在清单里
//     （进程实际跑的可执行文件是版本号改过的副本）：卡弹出来，不建记录、没有键打进去、
//     没有副作用，头部分别没有提示 / `mode_excluded` / `unverified_version`。
//
// 用 grok 的真画面与真文件，所以只在 `grok --version` 是已验证的版本时才有意义；没装或版本
// 不在清单里记 skipped。不需要 `ARMADRA_E2E_REAL=1`：没有真账号、没有真模型。
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CREDENTIAL_VARIABLES, probeHome } from "../probe-home.mjs";
import {
  blockRealClis,
  cleanups,
  note,
  scenario,
  sleep,
  startIsolatedCore,
  waitFor,
  which,
} from "./lib.mjs";
import { mockModelServer } from "./mock-model.mjs";

/** `core/agent/grok-answer.ts` 的已验证版本清单里的那个。 */
const VERIFIED = "1.0.92";
const ROUNDS = Number(process.env.ARMADRA_E2E_GROK_ROUNDS ?? 20);

/** 目录里所有文件的内容哈希（路径与内容），`skip` 里的顶层名字与 `.lock` 不算。 */
function dirHash(root, skip = []) {
  const hash = createHash("sha256");
  const walk = (dir, top) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (top && skip.some((name) => entry.name.startsWith(name))) continue;
      if (entry.name.endsWith(".lock")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, false);
      else {
        hash.update(`${path.slice(root.length)}\0`);
        hash.update(readFileSync(path));
      }
    }
  };
  if (!existsSync(root)) return "absent";
  walk(root, true);
  return hash.digest("hex");
}

/** 一份版本号被改成 1.0.91 的 grok 副本：门探到的版本不在清单里。 */
function oldGrokCopy(scratch, grok) {
  const native = realpathSync(grok);
  const copy = join(scratch, "grok-old");
  writeFileSync(
    copy,
    readFileSync(native).toString("latin1").replaceAll(VERIFIED, "1.0.91"),
    "latin1",
  );
  chmodSync(copy, 0o755);
  if (process.platform === "darwin")
    execFileSync("codesign", ["--force", "-s", "-", copy], { stdio: "ignore" });
  return copy;
}

/** 画面里与审批卡有关的行（计时、标题行不算）：比较「有没有键打进去」用。 */
const cardRegion = (screen) =>
  screen
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => /┃|:select|Enter:save|Tab:permission/.test(row))
    .join("\n");

const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

export default async function run19() {
  const s = scenario("19-grok-card-answer");
  try {
    const grok = which("grok");
    if (grok === undefined) {
      s.skip("没有装 grok");
      return;
    }
    let version = "";
    try {
      version = execFileSync(grok, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      // 读不到就按没有处理
    }
    if (!version.includes(` ${VERIFIED} `)) {
      s.skip(`grok 版本不是已验证的 ${VERIFIED}：${version}`);
      return;
    }

    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "armadra-grok-card-")),
    );
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const project = join(scratch, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q", project]);

    const probe = probeHome("armadra-grok-card-home-");
    cleanups.push(probe.remove);
    const grokHome = probe.env.GROK_HOME;
    mkdirSync(grokHome, { recursive: true });

    // 脚本化模型：队列里有一组工具调用就回它，工具结果回来之后回一句话收尾。
    const queue = [];
    const mock = await mockModelServer((body) => {
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      // 标题之类的辅助请求不带真工具表。
      if (!names.includes("run_terminal_command")) return { text: "ok" };
      const last = body.messages?.at(-1);
      if (last?.role === "tool") return { text: "done" };
      const next = queue.shift();
      return next === undefined
        ? { text: "nothing queued" }
        : { toolCalls: next };
    });
    writeFileSync(
      join(grokHome, "config.toml"),
      [
        "[models]",
        'default = "mock"',
        "[model.mock]",
        'model = "mock-1"',
        `base_url = "${mock.baseUrl}"`,
        'name = "Mock"',
        'api_key = "mock-not-a-credential"',
        "context_window = 100000",
        "[cli]",
        "auto_update = false",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(grokHome, "trusted_folders.toml"),
      `[folders."${project}"]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`,
    );

    // grok 的运行环境：临时 HOME 与 GROK_HOME，permission-mode 由包装脚本给（与启动器
    // 按节点的权限模式追加的旗标一致）。core 自己的 PATH 上也放一个同样环境的 grok，
    // 它探版本时拿到的是同一个。
    // `binary` 与 `mode`：不经 Armadra 启动的节点（缺省模式、旧版本副本）用；`mode` 为
    // `null` 就是不带权限旗标，grok 按缺省的 auto-review 起。
    const wrapperFor = (mode, binary = grok) => {
      const path = join(
        scratch,
        `run-grok-${mode ?? "default"}-${binary === grok ? "real" : "old"}.sh`,
      );
      writeFileSync(
        path,
        [
          "#!/bin/sh",
          `export HOME=${quote(probe.path)} GROK_HOME=${quote(grokHome)} GROK_TELEMETRY_ENABLED=0`,
          `exec ${quote(binary)} --no-memory${mode === null ? "" : ` --permission-mode ${mode}`}`,
          "",
        ].join("\n"),
      );
      chmodSync(path, 0o755);
      return path;
    };
    const shims = join(scratch, "bin");
    mkdirSync(shims);
    blockRealClis(shims, join(scratch, "blocked.log"), ["grok"]);
    writeFileSync(
      join(shims, "grok"),
      `#!/bin/sh\nexport HOME=${quote(probe.path)} GROK_HOME=${quote(grokHome)} GROK_TELEMETRY_ENABLED=0\nexec ${quote(grok)} "$@"\n`,
    );
    chmodSync(join(shims, "grok"), 0o755);

    const data = join(scratch, "rt");
    mkdirSync(data);
    const environment = {
      ...process.env,
      ...probe.env,
      PATH: `${shims}:${process.env.PATH ?? ""}`,
      ARMADRA_DATA_DIR: data,
      ARMADRA_LOG: "debug",
      ARMADRA_SECRET_BACKEND: "file",
      ARMADRA_NO_GLOBAL_WRITES: "1",
    };
    for (const name of [
      "TMUX",
      "TMUX_PANE",
      "CLAUDECODE",
      ...CREDENTIAL_VARIABLES,
    ])
      delete environment[name];
    const { api } = await startIsolatedCore({
      data,
      environment,
      logName: "core-grok-card.log",
    });
    await api("/api/settings", {
      method: "PATCH",
      body: {
        terminal: { ecoMode: false },
        agents: { grok: { answerCards: true } },
      },
    });

    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-grok-card",
        rootPath: project,
        permissions: { read: true, write: true, execute: true },
      },
    });
    const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
    const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const one = (sql, ...params) => database.prepare(sql).get(...params);
    const rows = (sql, ...params) => database.prepare(sql).all(...params);
    const tmuxSocket = join(data, "tmux.sock");

    const oldGrok = oldGrokCopy(scratch, grok);

    /**
     * 起一个 grok 节点，等到输入框出现。`mode`：节点声明的权限模式（`auto-edit` /
     * `plan`）。`via`：`armadra` 经 core 敲启动行（真旗标）；`default` 不带权限旗标直接
     * 起（节点上写着 auto-edit，进程实际是缺省模式）；`old` 起版本号改过的副本。
     */
    async function startNode(title, mode, via = "armadra") {
      const initial = await api(documentPath);
      const stamp = new Date().toISOString();
      const node = {
        id: randomUUID(),
        boardId: board.id,
        type: "terminal",
        title,
        color: "#0a84ff",
        position: { x: 0, y: 0 },
        size: { width: 700, height: 540 },
        labels: [],
        note: "",
        data: {
          kind: "terminal",
          cwd: project,
          agent: { id: "grok", permissionMode: mode },
        },
        createdAt: stamp,
        updatedAt: stamp,
      };
      await api(documentPath, {
        method: "PUT",
        body: {
          expectedUpdatedAt: initial.board.updatedAt,
          nodes: [node],
          edges: [],
          viewport: { x: 20, y: 20, zoom: 0.5 },
          whiteboard: "",
        },
      });
      const startedAt = Date.now() - 1000;
      const session = await api("/api/terminals", {
        method: "POST",
        body: {
          workspaceId: workspace.id,
          cwd: project,
          nodeId: node.id,
          agent: { id: "grok" },
          ...(via === "armadra"
            ? { launch: true }
            : {
                command:
                  via === "old"
                    ? wrapperFor("acceptEdits", oldGrok)
                    : wrapperFor(null),
                args: [],
              }),
        },
      });
      const screen = async () =>
        (await api(`/api/terminals/${session.id}/capture?lines=60`)).data ?? "";
      await waitFor(
        `${title}：grok 输入框出现`,
        async () =>
          /Mock ─╯|Signed in with/.test(await screen()) ? true : undefined,
        { timeout: 90_000, interval: 500 },
      ).catch(async (error) => {
        note(
          `${title}：等不到输入框时的屏幕`,
          (await screen()).split("\n").filter(Boolean).slice(-16),
        );
        throw error;
      });
      await sleep(1000);
      const grokCards = () =>
        rows(
          "SELECT id, answer FROM agent_approvals WHERE node_id = ? AND json_extract(request_json, '$.protocol') = 'grok-card' ORDER BY created_at",
          node.id,
        );
      const openCard = () =>
        grokCards()
          .filter((row) => row.answer === null)
          .at(-1);
      const events = () => {
        const base = join(grokHome, "sessions");
        const found = [];
        const walk = (dir) => {
          for (const entry of existsSync(dir)
            ? readdirSync(dir, { withFileTypes: true })
            : []) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (
              entry.name === "events.jsonl" &&
              statSync(path).birthtimeMs >= startedAt
            )
              found.push(path);
          }
        };
        walk(base);
        return found.flatMap((file) =>
          readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return {};
              }
            }),
        );
      };
      const send = (text) =>
        api(`/api/terminals/${session.id}/paste`, {
          method: "POST",
          body: { text, enter: true },
        });
      /** 绕过 core 的输入围栏，直接给 tmux 窗格发键（模拟人在终端里按键）。 */
      const key = (name, marker) => {
        // 这台 core 的 tmux 里有好几个节点的窗格：按画面里的标记认出这个节点的那一个。
        const panes = execFileSync(
          "tmux",
          ["-S", tmuxSocket, "list-panes", "-a", "-F", "#{pane_id}"],
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean);
        const target = panes.find((pane) =>
          execFileSync(
            "tmux",
            ["-S", tmuxSocket, "capture-pane", "-p", "-t", pane],
            { encoding: "utf8" },
          ).includes(marker),
        );
        if (target === undefined) throw new Error(`找不到窗格：${marker}`);
        execFileSync("tmux", [
          "-S",
          tmuxSocket,
          "send-keys",
          "-t",
          target,
          name,
        ]);
      };
      const status = () =>
        one(
          "SELECT state, pending_id FROM agent_status WHERE node_id = ?",
          node.id,
        );
      /** 这个节点头部要显示的那句（会话列表里的 `cardNotice`）。 */
      const notice = async () =>
        (await api(`/api/workspaces/${workspace.id}/sessions`)).find(
          (row) => row.nodeId === node.id,
        )?.cardNotice;
      return {
        node,
        session,
        notice,
        screen,
        send,
        key,
        status,
        grokCards,
        openCard,
        events,
      };
    }

    const commandCall = (command) => [
      {
        name: "run_terminal_command",
        arguments: { command, description: "probe" },
      },
    ];

    /** 等回合结束：状态不再是 blocked / working。 */
    const turnOver = (handle) =>
      waitFor(
        "本轮结束",
        () => {
          const row = one(
            "SELECT state FROM agent_status WHERE node_id = ?",
            handle.node.id,
          );
          return row && row.state !== "blocked" && row.state !== "working"
            ? row
            : undefined;
        },
        { timeout: 60_000, interval: 500 },
      );

    /* ------------------------------ 主体：允许 / 拒绝 ------------------------------ */
    const main = await startNode("grok-main", "auto-edit");
    // 经 Armadra 启动：core 敲的启动行带真旗标，grok 进程自己的 argv 里有它。
    const argvs = execFileSync("ps", ["-A", "-o", "args="], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\n")
      .filter((line) => line.includes("--permission-mode acceptEdits"));
    s.check(
      "经 Armadra 启动：grok 进程的 argv 带 --permission-mode acceptEdits",
      argvs.some((line) => /grok/.test(line)),
      argvs.map((line) => line.slice(0, 160)),
    );
    // GROK_HOME（运行时文件除外）与工程里的 .grok 按内容哈希比。
    const snapshot = () => ({
      grokHome: dirHash(grokHome, [
        "sessions",
        "logs",
        "active_sessions",
        "slash-mru",
        "memtrace",
        "worktrees",
        "prompt",
      ]),
      project: dirHash(join(project, ".grok")),
    });
    const before = snapshot();

    let confirmed = 0;
    const allowedCommands = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const decision of ["allow", "deny"]) {
        const file = `out-${decision}-${round}.txt`;
        const command = `sh -c "echo ${decision}${round} > ${file}"`;
        queue.push(commandCall(command));
        const requestsBefore = main
          .events()
          .filter((e) => e.type === "permission_requested").length;
        await main.send("go");
        const card = await waitFor(
          `${decision} #${round}：出现未答复的审批记录`,
          () => main.openCard(),
          { timeout: 60_000, interval: 300 },
        ).catch(async (error) => {
          note(`${decision} #${round}：等不到记录时`, {
            status: main.status(),
            settingsGrok: (await api("/api/settings")).agents?.grok,
            nodeData: one(
              "SELECT data_json FROM nodes WHERE id = ?",
              main.node.id,
            )?.data_json,
            cards: main.grokCards(),
            events: main
              .events()
              .map((e) => e.type)
              .slice(-12),
            screen: (await main.screen())
              .split("\n")
              .filter(Boolean)
              .slice(-14),
          });
          throw error;
        });
        const blockedRow = one(
          "SELECT state, pending_id FROM agent_status WHERE node_id = ?",
          main.node.id,
        );
        const answered = await api(`/api/approvals/${card.id}/answer`, {
          method: "POST",
          body: { decision, answeredBy: "probe" },
        }).catch(async (error) => {
          note(`${decision} #${round}：答复被拒`, {
            audit: rows(
              "SELECT accepted, route, refusal FROM agent_approval_audit WHERE approval_id = ?",
              card.id,
            ),
            screen: (await main.screen())
              .split("\n")
              .filter((row) => row.trim() !== "")
              .slice(-14),
          });
          throw error;
        });
        const resolved = await waitFor(
          `${decision} #${round}：文件里有这张卡的 permission_resolved`,
          () =>
            main.events().filter((e) => e.type === "permission_resolved")
              .length > requestsBefore
              ? main
                  .events()
                  .filter((e) => e.type === "permission_resolved")
                  .at(-1)
              : undefined,
          { timeout: 20_000, interval: 200 },
        ).catch(() => undefined);
        await turnOver(main).catch(() => undefined);
        await sleep(300);
        const ran = existsSync(join(project, file));
        const audited = rows(
          "SELECT accepted, route, refusal FROM agent_approval_audit WHERE approval_id = ?",
          card.id,
        );
        const ok =
          blockedRow?.state === "blocked" &&
          blockedRow?.pending_id === card.id &&
          answered.route === "keys" &&
          answered.delivery === "confirmed" &&
          resolved?.decision === decision &&
          ran === (decision === "allow") &&
          audited.some((a) => a.accepted === 1 && a.route === "keys");
        if (ok) confirmed += 1;
        else
          s.check(`${decision} #${round}`, false, {
            blocked: blockedRow,
            answered: { route: answered.route, delivery: answered.delivery },
            resolved: resolved?.decision,
            ran,
            audited,
          });
        if (decision === "allow") allowedCommands.push(command);
      }
    }
    s.check(
      `允许 / 拒绝各 ${ROUNDS} 轮：route keys、delivery confirmed、决定与文件一致、副作用与所答一致、审计 keys`,
      confirmed === ROUNDS * 2,
      { confirmed, expected: ROUNDS * 2 },
    );
    const after = snapshot();
    s.check(
      "GROK_HOME 与工程里的 .grok 内容哈希不变（没选到 Always / Never / always-approve）",
      JSON.stringify(before) === JSON.stringify(after),
      { before, after },
    );
    // 对照：允许过的命令再来一次，卡片又弹出来。
    queue.push(commandCall(allowedCommands[0]));
    const opened = main.grokCards().length;
    await main.send("again");
    const again = await waitFor(
      "允许过的同一条命令再来：卡片又弹出来",
      () => (main.grokCards().length > opened ? main.openCard() : undefined),
      { timeout: 60_000, interval: 300 },
    ).catch(() => undefined);
    s.check("允许一次没有被记成规则：同一条命令再次弹卡", again !== undefined);
    if (again !== undefined) {
      await api(`/api/approvals/${again.id}/answer`, {
        method: "POST",
        body: { decision: "deny", answeredBy: "probe" },
      }).catch(() => undefined);
      await turnOver(main).catch(() => undefined);
    }

    /* ---------------------------------- 负例 ---------------------------------- */
    /** 卡弹出来之后：没有记录、没有键打进去（卡区域不变）、没有副作用。 */
    async function declined(label, node, file, notice) {
      queue.push(commandCall(`sh -c "echo x > ${file}"`));
      await node.send("go");
      await waitFor(
        `${label}：画面出现审批卡`,
        async () =>
          /\d\/\d:select/.test(await node.screen()) ? true : undefined,
        { timeout: 60_000, interval: 300 },
      );
      const regionBefore = cardRegion(await node.screen());
      await sleep(3500);
      const resolved = node
        .events()
        .filter((e) => e.type === "permission_resolved").length;
      s.check(
        `${label}：不建审批记录、头部${notice === undefined ? "没有提示" : `提示 ${notice}`}、没有键打进去、没有副作用`,
        node.grokCards().length === 0 &&
          (await node.notice()) === notice &&
          cardRegion(await node.screen()) === regionBefore &&
          resolved === 0 &&
          !existsSync(join(project, file)),
        {
          cards: node.grokCards(),
          notice: await node.notice(),
          resolved,
        },
      );
    }
    // 设置关着：缺省就是关。
    {
      await api("/api/settings", {
        method: "PATCH",
        body: { agents: { grok: { answerCards: false } } },
      });
      const node = await startNode("grok-setting-off", "auto-edit");
      await declined("设置关着", node, "setting-off.txt", undefined);
      await api("/api/settings", {
        method: "PATCH",
        body: { agents: { grok: { answerCards: true } } },
      });
    }
    // 节点上写着 auto-edit，grok 进程实际是缺省模式（auto-review）起的：读进程 argv，不信节点。
    {
      const node = await startNode("grok-default-mode", "auto-edit", "default");
      await declined(
        "缺省模式的进程",
        node,
        "default-mode.txt",
        "mode_excluded",
      );
    }
    // 版本不在清单里（探的是进程实际跑的那个可执行文件）。
    {
      const node = await startNode("grok-old-version", "auto-edit", "old");
      await declined(
        "版本不在清单",
        node,
        "old-version.txt",
        "unverified_version",
      );
    }
    // 提问卡：不建记录。
    {
      const node = await startNode("grok-ask", "auto-edit");
      queue.push([
        {
          name: "ask_user_question",
          arguments: {
            questions: [
              {
                question: "Pick a color?",
                options: [
                  { label: "Red", description: "r" },
                  { label: "Blue", description: "b" },
                ],
              },
            ],
          },
        },
      ]);
      await node.send("go");
      await waitFor(
        "提问卡出现",
        async () =>
          /Type your answer here/.test(await node.screen()) ? true : undefined,
        { timeout: 60_000, interval: 300 },
      );
      await sleep(3000);
      s.check("提问卡：不建审批记录", node.grokCards().length === 0, {
        cards: node.grokCards(),
        state: node.status(),
      });
    }
    // 计划审阅：不建记录。
    {
      const node = await startNode("grok-plan", "plan");
      queue.push([{ name: "exit_plan_mode", arguments: {} }]);
      await node.send("go");
      await waitFor(
        "计划审阅出现",
        async () =>
          /plan approval|a approve/.test(await node.screen())
            ? true
            : undefined,
        { timeout: 60_000, interval: 300 },
      );
      await sleep(3000);
      s.check("计划审阅：不建审批记录", node.grokCards().length === 0, {
        cards: node.grokCards(),
        state: node.status(),
      });
    }
    // Esc / e：记录建成之后卡变了，答复 409、一个键都没发。
    for (const [label, name, expectFooter] of [
      ["Esc（焦点落到滚动区）", "Escape", /Tab:permission/],
      ["e（规则编辑态，卡已变）", "e", /Enter:save/],
    ]) {
      const node = await startNode(`grok-${name}`, "auto-edit");
      const command = `sh -c "echo ${name} > ${name}.txt"`;
      queue.push(commandCall(command));
      await node.send("go");
      const card = await waitFor(
        `${label}：出现审批记录`,
        () => node.openCard(),
        { timeout: 60_000, interval: 300 },
      );
      node.key(name, `echo ${name} > ${name}.txt`);
      await waitFor(
        `${label}：画面变了`,
        async () => (expectFooter.test(await node.screen()) ? true : undefined),
        { timeout: 10_000, interval: 200 },
      ).catch(async (error) => {
        note(
          `${label}：画面没变`,
          (await node.screen())
            .split("\n")
            .filter((row) => row.trim() !== "")
            .slice(-8),
        );
        throw error;
      });
      const regionBefore = cardRegion(await node.screen());
      const resolvedBefore = node
        .events()
        .filter((e) => e.type === "permission_resolved").length;
      const refused = await api(`/api/approvals/${card.id}/answer`, {
        method: "POST",
        body: { decision: "allow", answeredBy: "probe" },
      }).then(
        () => ({ status: 200 }),
        (error) => ({ message: String(error.message) }),
      );
      await sleep(1500);
      const resolvedAfter = node
        .events()
        .filter((e) => e.type === "permission_resolved").length;
      s.check(
        `${label}：答复被拒（409），记录还开着，没有发键`,
        /409/.test(refused.message ?? "") &&
          node.grokCards().find((row) => row.id === card.id)?.answer === null &&
          resolvedAfter === resolvedBefore &&
          // 画面上的卡区域与答复之前一字不差：没有键打进去。
          cardRegion(await node.screen()) === regionBefore &&
          !existsSync(join(project, `${name}.txt`)),
        { refused, resolvedBefore, resolvedAfter },
      );
    }
    // 并行卡：一条消息两个工具调用。grok 1.0.92 逐张出卡：第一张答完第二张才出现，
    // 所以唯一的期望是——第一张有记录且只有一条未决、答允许 confirmed；第二张有自己的
    // （新的）记录、答拒绝 confirmed；第一张的命令跑了、第二张没跑。
    {
      const node = await startNode("grok-parallel", "auto-edit");
      queue.push([
        ...commandCall('sh -c "echo a > par-a.txt"'),
        ...commandCall('sh -c "echo b > par-b.txt"'),
      ]);
      await node.send("go");
      const first = await waitFor(
        "并行卡：第一张有记录",
        () => node.openCard(),
        { timeout: 60_000, interval: 300 },
      );
      const count = () => ({
        requested: node
          .events()
          .filter((e) => e.type === "permission_requested").length,
        resolved: node.events().filter((e) => e.type === "permission_resolved")
          .length,
      });
      const atFirst = count();
      s.check(
        "并行卡：第一张出现时只有一条未决请求、一条未答的记录",
        atFirst.requested === 1 &&
          atFirst.resolved === 0 &&
          node.grokCards().filter((row) => row.answer === null).length === 1,
        atFirst,
      );
      const one1 = await api(`/api/approvals/${first.id}/answer`, {
        method: "POST",
        body: { decision: "allow", answeredBy: "probe" },
      }).catch((error) => ({ message: String(error.message) }));
      s.check(
        "并行卡：第一张答允许，confirmed",
        one1.delivery === "confirmed" && one1.route === "keys",
        one1,
      );
      const second = await waitFor(
        "并行卡：第二张有自己的新记录",
        () => {
          const open = node.openCard();
          return open !== undefined && open.id !== first.id ? open : undefined;
        },
        { timeout: 30_000, interval: 300 },
      ).catch(() => undefined);
      s.check("并行卡：第二张有新的审批记录", second !== undefined);
      const two = second
        ? await api(`/api/approvals/${second.id}/answer`, {
            method: "POST",
            body: { decision: "deny", answeredBy: "probe" },
          }).catch((error) => ({ message: String(error.message) }))
        : undefined;
      await sleep(2500);
      s.check(
        "并行卡：第二张答拒绝 confirmed；第一张的命令跑了、第二张的没跑",
        two?.delivery === "confirmed" &&
          existsSync(join(project, "par-a.txt")) &&
          !existsSync(join(project, "par-b.txt")),
        two,
      );
    }
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
