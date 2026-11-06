// 场景 15：协调者的主动接单（契约 §104，AMA-Link/Armadra#830，R4 第二阶段）。
//
// 不要真模型、不要真 forge、不要页面：和场景 11 一样自己起一套 core（`setupCore`）与
// 脚本化模型服务驱动随包的 ama；forge 是探针里一个几十行的本地假 Gitea（回环 http，
// 配成 `127.0.0.1` 这台主机的平台，令牌是假的）。不复用
// `core/forge/fake-gitea.fixture.ts`：它的时间戳固定在 2026-10，而来源建立时游标记
// 「现在」、不回灌更早的线程，夹具里的 issue 全在游标之前，出不了候选。
//
// 闭环（脚本化模型按对话走）：
//   1. 人在工作区写 `.armadra/router/rules.md`，经 `POST /api/workflows/sources` 给协
//      调者配一个 observe 来源（仓库 127.0.0.1/acme/app，看 issue，允许名单 alice）；
//      来源只能这样配，没有任何 canvas 动词能建或改。
//   2. 假 forge 出现一个 alice 开的 issue → IntakeWatch 出候选，协调者的事件队列多一
//      行 `intake`，卡片带 `canvas intake` 的用法。
//   3. 模型 `canvas_intake {candidate}` 读详情（正文第一行是外部资料标注），再
//      `canvas_intake {candidate, verdict: accept}` 判定。observe 下判定只记账：没有
//      新节点、没有工作项，候选没有 `item_id`。
//   4. 人把来源切 auto 并确认规则（同一个 HTTP 路由）；一个节点给协调者 `post` 一条
//      「接单」唤醒它，模型 `canvas_open_agent {candidate}` 起成员（假 CLI）。
//      断言：工作项 `mandate.basis = "rule"`、`origin.kind = "external"`、`threads`
//      里绑着 issue（`own = false`）、候选 `item_id` 与 `outcome = dispatched`。
//   5. 假 forge 在 issue 下加一条评论 → PrWatch 轮询 issue 线程 → 评论原文投给成员
//      （带外部资料标注），协调者只多一行 `external` 概要（不带评论原文）。
//
// 为什么慢：IntakeWatch 与 PrWatch 都搭 TaskWatch 的 60 秒定时器，来源每 120 秒、线
// 程每 60 秒才轮询一次（`MIN_SOURCE_POLL_MS` 等），这些间隔没有环境变量或测试开
// 关，为一个探针加生产旋钮不值得，所以探针老实等：全程约 4–6 分钟。因此只在
// `--only 15` 时跑，不进缺省场景，也不进 CI 的 `e2e.d`。
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { probeHome } from "../probe-home.mjs";
import { mockModelServer } from "./mock-model.mjs";
import {
  FAKE_KEY,
  controlAs,
  lastToolCall,
  setupCore,
  textOf,
} from "./scenario-11-coordinator.mjs";
import { CARD_MARK } from "./scenario-11-router.mjs";
import { cleanups, note, report, scenario, sleep, waitFor } from "./lib.mjs";

const OWNER = "acme";
const NAME = "app";
const FORGE_TOKEN = "gitea-probe-token";
const REPO = `127.0.0.1/${OWNER}/${NAME}`;
const MEMBER_AGENT = "custom:intakecli";
const ISSUE_TITLE = "登录页在窄屏下按钮被遮住";
const ISSUE_BODY = "复现：把窗口缩到 320 宽，登录按钮落在页脚后面。";
const COMMENT = "补充：Safari 17 上同样出现，截图见附件 intake-probe-9f3c";
const DISPATCH = "接单：请按 canvas intake 的候选派发";
const RULES = [
  "# 接单规则",
  "",
  "- 接：标了 `bug` 的 issue。",
  "- 不接：标了 `question` 的。",
  "",
].join("\n");

/** 成员用的假 CLI（借 Claude 的 hook 适配）：原样记下收到的每一段输入，回一轮。 */
const MEMBER_CLI = String.raw`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const hook = __HOOK__;
const session = "intakecli-" + process.pid;
function report(event, extra) {
  spawnSync(hook, ["claude"], {
    input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: process.cwd(), ...(extra || {}) }),
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 10000,
  });
}
report("SessionStart");
process.stdout.write("intakecli ready\n❯ \n");
let timer;
process.stdin.on("data", (chunk) => {
  fs.appendFileSync(__LOG__, String(chunk).replace(/\x1b\[20[01]~/g, "") + "\n--\n");
  report("UserPromptSubmit", { prompt: "x" });
  clearTimeout(timer);
  timer = setTimeout(() => {
    report("Stop");
    process.stdout.write("❯ \n");
  }, 300);
});
`;

/* ------------------------------- 假 Gitea ------------------------------- */

/**
 * 只答 `core/forge/gitea.ts` 为这个场景用到的几条：`/user`（配置时核验令牌）、issue
 * 列表（更新时间倒序）、单个 issue、issue 评论。时间戳用真实的现在。
 */
async function startForge() {
  const issues = [];
  const comments = new Map();
  const requests = [];
  let root = "";
  const iso = (ms) => new Date(ms).toISOString();
  const issueJson = (issue) => ({
    id: issue.number * 10,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: "open",
    user: { login: issue.author, id: 1 },
    labels: issue.labels.map((name, index) => ({ id: index + 1, name })),
    comments: (comments.get(issue.number) ?? []).length,
    html_url: `${root}/${OWNER}/${NAME}/issues/${issue.number}`,
    created_at: iso(issue.createdAt),
    updated_at: iso(
      Math.max(
        issue.createdAt,
        ...(comments.get(issue.number) ?? []).map((c) => c.at),
      ),
    ),
    pull_request: null,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    requests.push(`${request.method} ${url.pathname}`);
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.headers.authorization !== `token ${FORGE_TOKEN}`)
      return send(401, { message: "token is required" });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path === "/user") return send(200, { id: 9, login: "armadra-probe" });
    const prefix = `/repos/${OWNER}/${NAME}`;
    if (!path.startsWith(prefix)) return send(404, { message: "not found" });
    const rest = path.slice(prefix.length);
    let match;
    if (rest === "/issues") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const limit = Number(url.searchParams.get("limit") ?? "30");
      const sorted = issues
        .map(issueJson)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      return send(200, sorted.slice((page - 1) * limit, page * limit));
    }
    if ((match = rest.match(/^\/issues\/(\d+)$/))) {
      const issue = issues.find((item) => item.number === Number(match[1]));
      return issue === undefined
        ? send(404, { message: "not found" })
        : send(200, issueJson(issue));
    }
    if ((match = rest.match(/^\/issues\/(\d+)\/comments$/))) {
      return send(
        200,
        (comments.get(Number(match[1])) ?? []).map((item) => ({
          id: item.id,
          user: { login: item.login },
          body: item.body,
          created_at: iso(item.at),
          html_url: `${root}/${OWNER}/${NAME}/issues/${match[1]}#issuecomment-${item.id}`,
        })),
      );
    }
    return send(404, { message: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  root = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(() => server.close());
  return {
    root,
    requests,
    addIssue: (issue) => issues.push({ createdAt: Date.now(), ...issue }),
    addComment: (number, login, body) => {
      const list = comments.get(number) ?? [];
      list.push({ id: list.length + 1, login, body, at: Date.now() });
      comments.set(number, list);
    },
  };
}

/* ------------------------------ 脚本化模型 ------------------------------ */

/** 这一段（最后一条用户消息之后）里模型调过的工具及其入参。 */
function callsSinceLastUser(messages) {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (messages[index].role === "user") {
      start = index + 1;
      break;
    }
  return messages
    .slice(start)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.tool_calls ?? [])
    .map((call) => ({
      name: call.function?.name,
      args: (() => {
        try {
          return JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          return {};
        }
      })(),
    }));
}

function lastToolText(messages) {
  return textOf([...messages].reverse().find((m) => m.role === "tool"));
}

const candidateOf = (text) => /intake:[^\s"·]+/.exec(text)?.[0];

/** 协调者的「模型」：卡片里有 intake 行就读详情并判定；收到「接单」信就派发。 */
function coordinatorScript(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const calls = callsSinceLastUser(messages);
  if (last?.role === "user") {
    const text = textOf(last);
    if (text.includes(CARD_MARK)) {
      const id = candidateOf(text);
      return id === undefined
        ? { text: "外部事件已知晓。" }
        : {
            toolCalls: [
              { name: "canvas_intake", arguments: { candidate: id } },
            ],
          };
    }
    return { toolCalls: [{ name: "canvas_inbox", arguments: {} }] };
  }
  switch (lastToolCall(messages)) {
    case "canvas_intake": {
      const id = calls.find((call) => call.name === "canvas_intake")?.args
        .candidate;
      if (calls.some((call) => call.args.verdict !== undefined))
        return { text: "已判定。" };
      return {
        toolCalls: [
          {
            name: "canvas_intake",
            arguments: {
              candidate: id,
              verdict: "accept",
              reason: "标了 bug 且给了复现步骤，符合规则",
            },
          },
        ],
      };
    }
    case "canvas_inbox": {
      const text = lastToolText(messages);
      // 信里不带 id：用这次对话里前面判定过的那一条。
      const id = candidateOf(JSON.stringify(messages));
      let ids = [];
      try {
        ids = (JSON.parse(text).messages ?? []).map((entry) => entry.id);
      } catch {
        ids = [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      }
      if (text.includes("接单") && id !== undefined)
        return {
          toolCalls: [
            {
              name: "canvas_open_agent",
              arguments: {
                agent: MEMBER_AGENT,
                title: "issue-1",
                task: "处理这个 issue，进展按 report 回报",
                candidate: id,
              },
            },
          ],
        };
      return ids.length === 0
        ? { text: "收件箱是空的。" }
        : {
            toolCalls: ids.map((id) => ({
              name: "canvas_ack",
              arguments: { id },
            })),
          };
    }
    case "canvas_open_agent":
      return { text: "已按候选派发。" };
    default:
      return { text: "好的。" };
  }
}

/* --------------------------------- 入口 --------------------------------- */

export default async function run() {
  const s = scenario("15-intake");
  try {
    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "armadra-intake-")),
    );
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const mock = await mockModelServer(coordinatorScript);
    const forge = await startForge();
    const probe = probeHome("armadra-intake-home-");
    cleanups.push(probe.remove);
    const home = probe.path;
    mkdirSync(join(home, ".config", "ama"), { recursive: true });
    writeFileSync(
      join(home, ".config", "ama", "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          defaultModel: "deepseek/mock-coordinator",
          providers: { deepseek: { baseUrl: mock.baseUrl } },
        },
        null,
        2,
      )}\n`,
    );
    const context = await setupCore(scratch, home, probe.env);
    const { api, data, project } = context;
    note("数据目录", data);

    const hookBin = join(data, "bin", "armadra-hook");
    await waitFor("armadra-hook 就位", () => existsSync(hookBin), {
      timeout: 30_000,
      interval: 100,
    });
    const memberCli = join(scratch, "intakecli");
    const memberLog = join(scratch, "intakecli.log");
    writeFileSync(
      memberCli,
      MEMBER_CLI.replace("__HOOK__", JSON.stringify(hookBin)).replace(
        "__LOG__",
        JSON.stringify(memberLog),
      ),
    );
    chmodSync(memberCli, 0o755);
    await api("/api/agents/claude/integration/install", { method: "POST" });
    await api("/api/settings", {
      method: "PATCH",
      body: {
        terminal: { ecoMode: false },
        agents: {
          custom: [
            {
              id: MEMBER_AGENT,
              label: "intakecli",
              launchCmd: memberCli,
              baseAgent: "claude",
            },
          ],
        },
      },
    });
    await api("/api/agents/ama/credentials/deepseek", {
      method: "PUT",
      body: { apiKey: FAKE_KEY },
    });

    // forge：假 Gitea 配成 `127.0.0.1` 这台主机的平台（令牌只在这套隔离的 core 里）。
    await api("/api/forge/configs/127.0.0.1", {
      method: "PUT",
      body: { forge: "gitea", apiBase: forge.root, token: FORGE_TOKEN },
    });

    // 工作区、画板、协调者节点与一个会 `post` 的普通终端节点。
    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-intake",
        rootPath: project,
        permissions: { read: true, write: true, execute: true },
      },
    });
    const boards = await api(`/api/workspaces/${workspace.id}/boards`);
    const board =
      boards[0] ??
      (await api(`/api/workspaces/${workspace.id}/boards`, {
        method: "POST",
        body: { name: "e2e" },
      }));
    const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
    const initial = await api(documentPath);
    const stamp = new Date().toISOString();
    const node = (title, position, agent) => ({
      id: randomUUID(),
      boardId: board.id,
      type: "terminal",
      title,
      color: "#0a84ff",
      position,
      size: { width: 640, height: 400 },
      labels: [],
      note: "",
      data: { kind: "terminal", ...(agent === undefined ? {} : { agent }) },
      createdAt: stamp,
      updatedAt: stamp,
    });
    const lead = node(
      "lead",
      { x: 0, y: 0 },
      {
        id: "ama",
        permissionMode: "full-auto",
      },
    );
    const human = node("human", { x: 0, y: 500 }, { id: MEMBER_AGENT });
    await api(documentPath, {
      method: "PUT",
      body: {
        expectedUpdatedAt: initial.board.updatedAt,
        nodes: [lead, human],
        edges: [
          {
            id: randomUUID(),
            boardId: board.id,
            source: human.id,
            target: lead.id,
            kind: "link",
            role: "peer",
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
        viewport: { x: 0, y: 0, zoom: 0.5 },
        whiteboard: "",
      },
    });
    const agents = await api("/api/agents");
    const amaRow = agents.find((agent) => agent.id === "ama");
    const quote = (word) => `'${word.replace(/'/g, "'\\''")}'`;
    const line = [
      amaRow.launcher,
      amaRow.resolvedPath,
      "--permission-mode",
      "full-auto",
      "待命：之后会有事件卡片，按卡片里的用法处理。",
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
    await api("/api/terminals", {
      method: "POST",
      body: {
        workspaceId: workspace.id,
        cwd: project,
        nodeId: human.id,
        agent: { id: MEMBER_AGENT },
        command: "/bin/sh",
        args: ["-c", "sleep 3600"],
      },
    });

    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const one = (sql, ...params) => database.prepare(sql).get(...params);
    const all = (sql, ...params) => database.prepare(sql).all(...params);
    const nodeCount = () =>
      Number(
        one("SELECT COUNT(*) AS n FROM nodes WHERE board_id = ?", board.id).n,
      );
    await waitFor(
      "协调者 ama 起来并上报状态",
      () => one("SELECT state FROM agent_status WHERE node_id = ?", lead.id),
      { timeout: 90_000, interval: 500 },
    );
    await waitFor("协调者回完开场那一轮", () => mock.requests.length >= 1, {
      timeout: 60_000,
      interval: 500,
    });
    await sleep(2000);

    /* ---- 1. 规则文件与 observe 来源（只能经 HTTP，由人配） ---- */

    mkdirSync(join(project, ".armadra", "router"), { recursive: true });
    writeFileSync(join(project, ".armadra", "router", "rules.md"), RULES);
    const saved = await api("/api/workflows/sources", {
      method: "POST",
      body: {
        coordinatorNodeId: lead.id,
        repo: REPO,
        kinds: ["issue"],
        mode: "observe",
        allow: ["Alice"],
        enabled: true,
      },
    });
    const source = saved.source;
    s.check(
      "来源建成：observe、允许名单存小写、规则还没确认",
      source?.mode === "observe" &&
        source.repo === REPO &&
        JSON.stringify(source.allow) === JSON.stringify(["alice"]),
      source,
    );
    const rejected = await api("/api/workflows/sources", {
      method: "POST",
      body: {
        id: source.id,
        coordinatorNodeId: lead.id,
        repo: REPO,
        kinds: ["issue"],
        mode: "auto",
        allow: ["alice"],
        enabled: true,
      },
    }).then(
      () => undefined,
      (error) => String(error.message),
    );
    s.check(
      "规则没确认就切 auto 被 core 拒绝（400）",
      rejected !== undefined && rejected.includes("400"),
      rejected,
    );

    /* ---- 2. issue 出现 → 候选与 intake 事件 ---- */

    const nodesBefore = nodeCount();
    forge.addIssue({
      number: 1,
      title: ISSUE_TITLE,
      body: ISSUE_BODY,
      author: "alice",
      labels: ["bug"],
    });
    const candidate = await waitFor(
      "IntakeWatch 出候选（最多等一个 60 秒定时器）",
      () =>
        one(
          "SELECT id, authorized, verdict FROM router_intake WHERE coordinator_node_id = ?",
          lead.id,
        ),
      { timeout: 240_000, interval: 2000 },
    );
    s.check(
      "候选已授权（作者在允许名单里）",
      Number(candidate.authorized) === 1,
      candidate,
    );
    const event = one(
      "SELECT id, kind, summary FROM router_events WHERE id = ?",
      candidate.id,
    );
    s.check(
      "协调者的事件队列里有同 id 的 intake 行，概要一行且不带正文",
      event?.kind === "intake" &&
        !String(event.summary).includes(ISSUE_BODY) &&
        !String(event.summary).includes("\n"),
      event,
    );
    await waitFor(
      "协调者拿到带 intake 行的卡片",
      () =>
        mock.requests.some((request) =>
          (request.messages ?? []).some(
            (m) =>
              m.role === "user" &&
              textOf(m).includes(CARD_MARK) &&
              textOf(m).includes(candidate.id) &&
              textOf(m).includes("canvas intake --candidate"),
          ),
        ),
      { timeout: 120_000, interval: 1000 },
    );

    /* ---- 3. observe：读详情、判定 accept，但什么都不派 ---- */

    const decided = await waitFor(
      "判定写进账本",
      () =>
        one(
          "SELECT verdict, verdict_reason, mode_at_verdict, rules_hash, item_id FROM router_intake WHERE id = ? AND verdict IS NOT NULL AND verdict <> ''",
          candidate.id,
        ),
      { timeout: 120_000, interval: 1000 },
    );
    s.check(
      "判定 accept、当时模式 observe、记了规则哈希",
      decided.verdict === "accept" &&
        decided.mode_at_verdict === "observe" &&
        String(decided.rules_hash).length === 16,
      decided,
    );
    const calls = mock.requests
      .flatMap((request) => request.messages ?? [])
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.tool_calls ?? [])
      .filter((call) => call.function?.name === "canvas_intake");
    s.check(
      "模型先 candidate 读详情，再 candidate + verdict 判定",
      calls.length >= 2,
      calls.map((call) => call.function?.arguments),
    );
    const detail = mock.requests
      .flatMap((request) => request.messages ?? [])
      .filter((m) => m.role === "tool")
      .map(textOf)
      .find((text) => text.includes("接单规则") && text.includes(ISSUE_BODY));
    s.check(
      "详情里有人写的规则与 issue 正文，正文前有外部资料标注",
      detail !== undefined && /外部|不可信|资料/.test(detail),
      detail?.slice(0, 400),
    );
    await sleep(3000);
    s.check(
      "observe 下 accept 之后没有新节点、没有工作项，候选没有 item_id",
      nodeCount() === nodesBefore &&
        Number(
          one(
            "SELECT COUNT(*) AS n FROM workflow_task_runs WHERE coordinator_node_id = ?",
            lead.id,
          ).n,
        ) === 0 &&
        (decided.item_id ?? null) === null,
      { nodes: nodeCount(), before: nodesBefore },
    );

    /* ---- 4. 人切 auto + 确认规则 → 模型 open-agent --candidate ---- */

    const auto = await api("/api/workflows/sources", {
      method: "POST",
      body: {
        id: source.id,
        coordinatorNodeId: lead.id,
        repo: REPO,
        kinds: ["issue"],
        mode: "auto",
        allow: ["alice"],
        enabled: true,
        confirmRules: true,
      },
    });
    s.check(
      "确认规则后切 auto 成功，来源记着规则哈希",
      auto.source?.mode === "auto" &&
        String(auto.source.rulesHash).length === 16,
      auto.source,
    );
    // 页面把画布上的边物化成每个节点的连线文档；探针替页面写一份（human → lead）。
    await api(`/api/workspaces/${workspace.id}/context-links/${human.id}`, {
      method: "PUT",
      body: {
        links: [{ id: lead.id, title: "lead", kind: "node", role: "peer" }],
      },
    });
    const wake = await controlAs(data, human.id, "post", {
      to: lead.id,
      key: "dispatch-1",
      body: DISPATCH,
    });
    s.check("唤醒协调者的 post 被收下", wake !== undefined, wake);
    const item = await waitFor(
      "候选起出工作项",
      () =>
        one(
          "SELECT task_id, node_id, origin_json, mandate_json, threads FROM workflow_task_runs WHERE coordinator_node_id = ?",
          lead.id,
        ),
      { timeout: 180_000, interval: 1000 },
    ).catch((error) => {
      note(
        "模型最后几条消息",
        (mock.requests.at(-1)?.messages ?? [])
          .slice(-4)
          .map(
            (m) =>
              `${m.role}: ${JSON.stringify(m.tool_calls ?? textOf(m)).slice(0, 500)}`,
          ),
      );
      note("请求数", mock.requests.length);
      throw error;
    });
    const mandate = JSON.parse(item.mandate_json);
    const origin = JSON.parse(item.origin_json);
    const threads = JSON.parse(item.threads);
    s.check(
      "工作项 mandate.basis = rule，授权范围指向这个来源",
      mandate.basis === "rule" &&
        mandate.by === lead.id &&
        String(mandate.scope).startsWith(`intake:${source.id}:`) &&
        String(mandate.scope).endsWith(":alice"),
      mandate,
    );
    s.check(
      "origin 是 external，原文带外部资料标注与链接",
      origin.kind === "external" &&
        origin.ref === candidate.id &&
        String(origin.text).includes(ISSUE_BODY),
      origin,
    );
    s.check(
      "issue 线程已绑到这一项（只看、不收尾）",
      threads.length === 1 &&
        threads[0].kind === "issue" &&
        threads[0].number === 1 &&
        threads[0].own === false,
      threads,
    );
    const after = one(
      "SELECT item_id, outcome FROM router_intake WHERE id = ?",
      candidate.id,
    );
    s.check(
      "候选记着 item_id 与 outcome = dispatched",
      after.item_id === item.task_id && after.outcome === "dispatched",
      after,
    );
    s.check(
      "成员节点起在画布上、任务投进了假 CLI",
      await waitFor(
        "成员收到首条任务",
        () => existsSync(memberLog) && readFileSync(memberLog, "utf8"),
        { timeout: 120_000, interval: 1000 },
      ).then(
        (text) => text.includes("处理这个 issue"),
        () => false,
      ),
    );

    /* ---- 5. issue 下来一条评论 → 成员收到原文，协调者只多一行 external ---- */

    const externalBefore = Number(
      one(
        "SELECT COUNT(*) AS n FROM router_events WHERE coordinator_node_id = ? AND kind = 'external'",
        lead.id,
      ).n,
    );
    forge.addComment(1, "alice", COMMENT);
    await waitFor(
      "PrWatch 把评论投给成员（最多等一个 60 秒定时器 + 线程间隔）",
      () =>
        readFileSync(memberLog, "utf8").includes("intake-probe-9f3c") ||
        undefined,
      { timeout: 240_000, interval: 2000 },
    );
    const delivered = readFileSync(memberLog, "utf8");
    s.check(
      "成员收到评论原文，带外部资料标注",
      delivered.includes(COMMENT) && /外部|不可信|资料/.test(delivered),
    );
    const externals = all(
      "SELECT id, summary FROM router_events WHERE coordinator_node_id = ? AND kind = 'external' ORDER BY created_at",
      lead.id,
    );
    s.check(
      "协调者只多一行 external 概要，不带评论原文",
      externals.length === externalBefore + 1 &&
        !externals.at(-1).summary.includes("intake-probe-9f3c") &&
        /issue #1/.test(externals.at(-1).summary),
      externals,
    );
    await sleep(3000);
    s.check(
      "评论原文没有进协调者的任何一次模型请求",
      !JSON.stringify(mock.requests).includes("intake-probe-9f3c"),
    );
    report.intake = {
      forgeRequests: forge.requests.length,
      mockRequests: mock.requests.length,
    };
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
