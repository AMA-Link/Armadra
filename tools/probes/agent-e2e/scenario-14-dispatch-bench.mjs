// 场景 14：分派基准（契约 §101，#704 R3 第 4 条）。
//
// 一个协调者（ama，真模型）带两个成员，事件流是固定的：一次「做好了」、一次带问题
// 的受阻、一次人的追问、一次交回；成员是脚本化的——由探针以成员身份直接调
// `report` / `handback`，不起真 CLI。同一条事件流跑两种预设各 3 次：`default`（
// 没有 `role`，ama 带着 bash / edit / write）与 `coordinator`（`--tools-preset
// coordinator`），记下完成时间和协调者的 token 用量。
//
// 断言（`coordinator` 预设）：会话里没有 bash / edit / write；做好了的那项经
// `notify result` 告诉人；受阻的问题经 `notify attention` 原样转达；追问经
// `notify answer` 回答；没有用 progress 去 `notify`（核心的闸门会 409，所以被拒的
// 尝试也算）；事件都被确认。`default` 预设只记数、不判（它是对照）。
//
// 前提（缺任何一条就整场景记 skipped 并写原因，不报错、不起任何进程）：
//   * `ARMADRA_E2E_REAL=1`（真模型花真额度，不进 CI）；
//   * 模型：`ARMADRA_E2E_AMA_KEY`（供应商 key，只经 core 的临时文件密钥后端兑换给
//     ama），或 `--ama-config`——让 ama 直接用本机已配好的 `~/.config/ama/config.json`
//     （只经 `XDG_CONFIG_HOME` 指给 ama，探针不读、不复制、不打印其中的任何 key，
//     跑前跑后只比对该文件的哈希）。
// `--self-test`：脚本化模型冒充真供应商，走一遍探针本身，不要任何前提。
// 次数：`ARMADRA_E2E_BENCH_RUNS`（缺省 3）。
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
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { probeHome } from "../probe-home.mjs";
import { mockModelServer } from "./mock-model.mjs";
import { CARD_MARK } from "./scenario-11-router.mjs";
import {
  FAKE_KEY,
  controlAs,
  lastToolCall,
  setupCore,
  textOf,
} from "./scenario-11-coordinator.mjs";
import {
  cleanups,
  note,
  realAllowed,
  report,
  scenario,
  selfTest,
  waitFor,
} from "./lib.mjs";

const ARMS = ["default", "coordinator"];
const RUNS = Number(process.env.ARMADRA_E2E_BENCH_RUNS || 3);
const QUESTION = "用哪个测试账号？";
const FOLLOWUP_ASK = "src/x 审到哪了";
const PROMPT =
  "让 reviewer-a 审查 src/x，reviewer-b 审查 src/y：用 canvas_team 建两个成员，agent 用 custom:benchcli，标题就叫 reviewer-a 和 reviewer-b，任务分别是「审查 src/x」「审查 src/y」；建完回一句话结束。";
const AMA_CONFIG = join(homedir(), ".config", "ama", "config.json");
const BENCH_CLI =
  "#!/bin/sh\nprintf 'bench ready\\n> \\n'\nexec cat >/dev/null\n";

/** 文件的 sha256（只用于比对，不读出内容）。 */
function digest(path) {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
}

/** 前提不满足的原因；满足答 `undefined`。 */
function whySkipped(useConfig) {
  if (selfTest) return undefined;
  if (!realAllowed)
    return "真模型会花真额度：以 ARMADRA_E2E_REAL=1 运行（只验证探针本身用 --self-test）";
  if (useConfig) {
    return existsSync(AMA_CONFIG)
      ? undefined
      : `--ama-config 要本机的 ${AMA_CONFIG}，没有找到`;
  }
  return process.env.ARMADRA_E2E_AMA_KEY
    ? undefined
    : "没有模型：设 ARMADRA_E2E_AMA_KEY（供应商 key），或加 --ama-config 用本机已配好的 ama 配置";
}

/* ----------------------------- 脚本化模型（自检） ---------------------------- */

/** 自检用的「理想协调者」：起团队、读卡片、按事件种类对人说话、逐条确认。 */
async function idealScript(body) {
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const last = messages[messages.length - 1];
  if (lastUser !== undefined && textOf(lastUser).includes(CARD_MARK)) {
    if (last?.role === "user")
      return { toolCalls: [{ name: "canvas_events", arguments: {} }] };
    if (lastToolCall(messages) === "canvas_events") {
      const listed = textOf(
        [...messages].reverse().find((m) => m.role === "tool"),
      );
      const calls = [];
      for (const line of listed.split("\n")) {
        const [id, item, kind, summary = ""] = line.split(" · ");
        if (!/^[a-z-]+:/.test(id ?? "")) continue;
        if (kind === "report" && summary.includes("ready"))
          calls.push({
            name: "canvas_notify",
            arguments: { purpose: "result", item, text: "做好了，请验收" },
          });
        if (kind === "attention") {
          const question = summary.split(" ? ")[1] ?? "";
          calls.push({
            name: "canvas_notify",
            arguments: { purpose: "attention", item, text: question },
          });
        }
        if (kind === "followup" && id.startsWith("followup:"))
          calls.push({
            name: "canvas_notify",
            arguments: {
              purpose: "answer",
              item,
              followup: id,
              text: "正在审，稍后给结论",
            },
          });
        calls.push({ name: "canvas_ack", arguments: { event: id } });
      }
      return calls.length === 0
        ? { text: "没有要处理的事件。" }
        : { toolCalls: calls };
    }
    return { text: "事件已处理。" };
  }
  if (last?.role === "user")
    return {
      toolCalls: [
        {
          name: "canvas_team",
          arguments: {
            member: [
              "custom:benchcli|reviewer-a|审查 src/x",
              "custom:benchcli|reviewer-b|审查 src/y",
            ],
          },
        },
      ],
    };
  return { text: "好的。" };
}

/* -------------------------------- 会话取数 --------------------------------- */

/** 目录下所有 .jsonl。 */
function sessionFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/** 协调者会话里的工具调用（名字与参数）和 token 用量。 */
function readSession(...dirs) {
  const calls = [];
  let tokens = 0;
  const files = [...new Set(dirs.flatMap(sessionFiles))];
  note(
    "会话文件",
    files.map((file) => file.split("/").slice(-3).join("/")),
  );
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant") continue;
      tokens += Number(message.usage?.totalTokens ?? 0);
      for (const block of message.content ?? [])
        if (block?.type === "toolCall")
          calls.push({ name: block.name, args: block.arguments ?? {} });
    }
  }
  return { calls, tokens };
}

/* --------------------------------- 一次运行 -------------------------------- */

async function oneRun({ arm, useConfig, index }) {
  const started = Date.now();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-bench-")));
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const mock = selfTest ? await mockModelServer(idealScript) : undefined;
  const probe = probeHome("armadra-bench-home-");
  cleanups.push(probe.remove);
  const home = probe.path;
  const extraEnv = {};
  if (useConfig) {
    // ama 直接读本机的配置；key 不经过探针。
    extraEnv.XDG_CONFIG_HOME = join(homedir(), ".config");
  } else {
    mkdirSync(join(home, ".config", "ama"), { recursive: true });
    writeFileSync(
      join(home, ".config", "ama", "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          defaultModel: `${selfTest ? "deepseek" : process.env.ARMADRA_E2E_AMA_PROVIDER || "deepseek"}/${selfTest ? "mock-bench" : process.env.ARMADRA_E2E_AMA_MODEL || "deepseek-chat"}`,
          ...(selfTest
            ? { providers: { deepseek: { baseUrl: mock.baseUrl } } }
            : process.env.ARMADRA_E2E_AMA_BASE_URL
              ? {
                  providers: {
                    [process.env.ARMADRA_E2E_AMA_PROVIDER || "deepseek"]: {
                      baseUrl: process.env.ARMADRA_E2E_AMA_BASE_URL,
                    },
                  },
                }
              : {}),
        },
        null,
        2,
      )}\n`,
    );
  }
  const { api, data, project } = await setupCore(scratch, home, {
    ...probe.env,
    ...extraEnv,
  });
  const cli = join(scratch, "benchcli");
  writeFileSync(cli, BENCH_CLI);
  chmodSync(cli, 0o755);
  await api("/api/settings", {
    method: "PATCH",
    body: {
      terminal: { ecoMode: false },
      agents: {
        custom: [
          {
            id: "custom:benchcli",
            label: "benchcli",
            launchCmd: cli,
            baseAgent: "claude",
          },
        ],
      },
    },
  });
  if (!useConfig) {
    const key = selfTest ? FAKE_KEY : process.env.ARMADRA_E2E_AMA_KEY;
    const provider = selfTest
      ? "deepseek"
      : process.env.ARMADRA_E2E_AMA_PROVIDER || "deepseek";
    await api(`/api/agents/ama/credentials/${provider}`, {
      method: "PUT",
      body: { apiKey: key },
    });
  }
  const amaRow = (await api("/api/agents")).find((row) => row.id === "ama");
  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: {
      name: "dispatch-bench",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    },
  });
  const boards = await api(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: { name: "bench" },
    }));
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const initial = await api(documentPath);
  const stamp = new Date().toISOString();
  const lead = {
    id: randomUUID(),
    boardId: board.id,
    type: "terminal",
    title: "lead",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 640, height: 400 },
    labels: [],
    note: "",
    data: {
      kind: "terminal",
      agent: { id: "ama", permissionMode: "full-auto" },
    },
    createdAt: stamp,
    updatedAt: stamp,
  };
  await api(documentPath, {
    method: "PUT",
    body: {
      expectedUpdatedAt: initial.board.updatedAt,
      nodes: [lead],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 0.5 },
      whiteboard: "",
    },
  });
  const quote = (word) => `'${word.replace(/'/g, "'\\''")}'`;
  const line = [
    amaRow.launcher,
    amaRow.resolvedPath,
    "--permission-mode",
    "full-auto",
    ...(arm === "coordinator" ? ["--tools-preset", "coordinator"] : []),
    PROMPT,
  ]
    .map(quote)
    .join(" ");
  await api("/api/terminals", {
    method: "POST",
    body: {
      workspaceId: workspace.id,
      cwd: project,
      nodeId: lead.id,
      agent: { id: "ama" },
      command: "/bin/sh",
      args: ["-c", `${line}; exit $?`],
    },
  });
  const database = new DatabaseSync(join(data, "canvas.db"), {
    readOnly: true,
  });
  cleanups.push(() => database.close());
  const rows = (sql, ...params) => database.prepare(sql).all(...params);
  const calm = () =>
    Number(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM router_events WHERE coordinator_node_id = ? AND acked_at IS NULL",
        )
        .get(lead.id).n,
    ) === 0 &&
    !["working", "blocked", "waiting"].includes(
      database
        .prepare("SELECT state FROM agent_status WHERE node_id = ?")
        .get(lead.id)?.state,
    );

  // 成员由协调者建出来：账本里两行。
  const items = await waitFor(
    "协调者建出两个成员",
    () => {
      const found = rows(
        "SELECT task_id, node_id, title FROM workflow_task_runs WHERE coordinator_node_id = ? ORDER BY started_at",
        lead.id,
      );
      return found.length >= 2 ? found : undefined;
    },
    { timeout: 180_000, interval: 1000 },
  );
  const [itemA, itemB] = items;
  await waitFor("协调者空闲", calm, { timeout: 120_000, interval: 1000 });

  // 成员的终端：像场景 11 那样替它们各开一个 shell 并换节点令牌（没有页面）。
  for (const item of [itemA, itemB]) {
    const memberSession = await api("/api/terminals", {
      method: "POST",
      body: {
        workspaceId: workspace.id,
        cwd: project,
        nodeId: item.node_id,
        shell: "/bin/sh",
      },
    });
    await api(`/api/terminals/${memberSession.id}/node-token/refresh`, {
      method: "POST",
    });
  }

  const settled = (label) =>
    waitFor(label, calm, { timeout: 240_000, interval: 1000 });
  const asMember = (item, verb, args) =>
    controlAs(data, item.node_id, verb, { item: item.task_id, ...args });

  // 1. B 做好了。
  await asMember(itemB, "report", {
    state: "ready",
    summary: "src/y 审完，要补测试",
  });
  await waitFor(
    "对人说了验收",
    () =>
      rows(
        "SELECT 1 FROM router_replies WHERE item_id = ? AND purpose = 'result'",
        itemB.task_id,
      ).length > 0,
    { timeout: 240_000, interval: 1000 },
  ).catch(() => undefined);
  await settled("第 1 步处理完");
  // 2. A 受阻并问人。
  await asMember(itemA, "report", {
    state: "blocked",
    summary: "缺少测试账号",
    "human-action": QUESTION,
  });
  await waitFor(
    "对人转达了问题",
    () =>
      rows(
        "SELECT 1 FROM router_replies WHERE item_id = ? AND purpose = 'attention'",
        itemA.task_id,
      ).length > 0,
    { timeout: 240_000, interval: 1000 },
  ).catch(() => undefined);
  await settled("第 2 步处理完");
  // 3. 人追问 A：写一条追问事件（真路径是协调者提示词里的 `#id`，这里直接落表，
  // 由 60 秒清扫投卡片）。
  const writer = new DatabaseSync(join(data, "canvas.db"));
  const followup = `followup:${itemA.task_id}:bench${index}`;
  writer
    .prepare(
      "INSERT OR IGNORE INTO router_events (id, coordinator_node_id, workspace_id, kind, item_id, source_node_id, summary, created_at, carded_at, acked_at) " +
        "VALUES (?, ?, ?, 'followup', ?, ?, ?, ?, NULL, NULL)",
    )
    .run(
      followup,
      lead.id,
      workspace.id,
      itemA.task_id,
      itemA.node_id,
      `已排队转给「${itemA.title}」：${FOLLOWUP_ASK}`,
      Date.now(),
    );
  writer.close();
  await waitFor(
    "回答了追问",
    () =>
      rows("SELECT 1 FROM router_replies WHERE id = ?", `answer:${followup}`)
        .length > 0,
    { timeout: 240_000, interval: 1000 },
  ).catch(() => undefined);
  await settled("第 3 步处理完");
  // 4. A 交回。
  await asMember(itemA, "handback", { reason: "不属于这件事" });
  await settled("第 4 步处理完");

  const durationMs = Date.now() - started;
  const replies = rows(
    "SELECT id, item_id, purpose, text FROM router_replies WHERE coordinator_node_id = ?",
    lead.id,
  );
  const open = rows(
    "SELECT id FROM router_events WHERE coordinator_node_id = ? AND acked_at IS NULL",
    lead.id,
  );
  const session = readSession(home, scratch);
  return {
    arm,
    durationMs,
    itemA,
    itemB,
    replies,
    open,
    followup,
    ...session,
    mock,
  };
}

/* ---------------------------------- 入口 ---------------------------------- */

export default async function run() {
  const s = scenario("14-dispatch-bench");
  try {
    const useConfig = process.argv.includes("--ama-config");
    const reason = whySkipped(useConfig);
    if (reason !== undefined) {
      s.skip(reason);
      return;
    }
    const configBefore = useConfig ? digest(AMA_CONFIG) : undefined;
    const results = [];
    for (const arm of ARMS) {
      for (let index = 0; index < RUNS; index += 1) {
        note(`分派基准：${arm} 第 ${index + 1}/${RUNS} 次`);
        const result = await oneRun({ arm, useConfig, index });
        results.push(result);
        const names = result.calls.map((call) => call.name);
        const writes = names.filter((name) =>
          ["bash", "edit", "write"].includes(name),
        );
        const notifies = result.calls.filter(
          (call) => call.name === "canvas_notify",
        );
        const label = `${arm}#${index + 1}`;
        if (arm === "coordinator") {
          s.check(
            `${label} 会话里没有 bash / edit / write`,
            writes.length === 0,
            writes,
          );
          s.check(
            `${label} 做好了的那项经 notify result 告诉人`,
            result.replies.some(
              (reply) =>
                reply.purpose === "result" &&
                reply.item_id === result.itemB.task_id,
            ),
            result.replies,
          );
          s.check(
            `${label} 待决问题经 notify attention 原样转达`,
            result.replies.some(
              (reply) =>
                reply.purpose === "attention" &&
                reply.item_id === result.itemA.task_id &&
                reply.text.includes(QUESTION),
            ),
            result.replies,
          );
          s.check(
            `${label} 追问经 notify answer 回答，且是对的那一项`,
            result.replies.some(
              (reply) =>
                reply.id === `answer:${result.followup}` &&
                reply.item_id === result.itemA.task_id,
            ),
            result.replies,
          );
          s.check(
            `${label} 没有用 progress 去 notify，也没有被闸门拒过`,
            notifies.every((call) =>
              ["answer", "result", "attention"].includes(call.args.purpose),
            ) && notifies.length === result.replies.length,
            { notifies: notifies.length, accepted: result.replies.length },
          );
          s.check(
            `${label} 事件都已确认`,
            result.open.length === 0,
            result.open,
          );
        }
        note(`${label} 完成`, {
          seconds: Math.round(result.durationMs / 1000),
          tokens: result.tokens,
          writes: writes.length,
          notifies: notifies.length,
        });
      }
    }
    report.dispatchBench = ARMS.map((arm) => {
      const own = results.filter((result) => result.arm === arm);
      const mean = (values) =>
        values.length === 0
          ? 0
          : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      return {
        arm,
        runs: own.length,
        seconds: own.map((result) => Math.round(result.durationMs / 1000)),
        tokens: own.map((result) => result.tokens),
        meanSeconds: mean(own.map((result) => result.durationMs / 1000)),
        meanTokens: mean(own.map((result) => result.tokens)),
        writeCalls: own.map(
          (result) =>
            result.calls.filter((call) =>
              ["bash", "edit", "write"].includes(call.name),
            ).length,
        ),
      };
    });
    note("分派基准汇总", report.dispatchBench);
    if (useConfig)
      s.check(
        "本机的 ama 配置没有被改动（哈希不变）",
        digest(AMA_CONFIG) === configBefore,
      );
    s.finish();
  } catch (error) {
    s.fail(error);
  }
}
