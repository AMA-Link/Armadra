// 场景 16：对话交接 v2 端到端（Issue #872，设计 handoff-v2）。
//
// 不用真模型、不用真 CLI 登录：自己起一套 core（临时数据目录、临时 HOME、文件密钥
// 后端，PATH 最前面是真 CLI 的替身），节点都是真终端会话（真 PTY，tmux 后端）、
// 真节点令牌，目标侧一律经真 `armadra-hook` 客户端（CLI 与 `armadra-hook mcp`）。
// 来源转录是各家 CLI 形状的夹具文件（OpenCode 是临时 XDG_DATA_HOME 下的库，ACP 来
// 源是假 ACP Agent 起的真会话），经 `/hook/<agent>` 以节点令牌上报转录路径，与真
// CLI 的 Hook 走同一条路，所以 `agent_status` 是 verified、绑着会话代次。
//
// 断言：
//   * prepare → accept：目标收件箱出现 `handoff:<id>`，空闲的 Codex 目标（假 TUI，
//     进程名 codex）的终端里收到唤醒行；
//   * 任务简报：Markdown，含完成标准与做完之后的 post / ack 命令，命令按目标通道写
//     （Codex 目标用 `canvas_*` 工具名，其余用 `armadra-hook canvas …`）；
//   * `--format json` 得 version 2 的冻结包（带 sourceCursor）；
//   * `--part transcript`：Claude、Codex、Pi、OpenCode、ACP 时间线五种来源条目形
//     状一致；冻结后来源追加的内容读不到；改写来源前缀退回摘录并标
//     `transcriptChanged`；分页游标连续无重复无遗漏；`--raw` 给原行；
//   * 读不等于确认，`canvas ack` 之后状态才是 `acknowledged`；来源自己读被拒；撤回
//     后读被拒；
//   * 目标 `post --key handoff:<id>:result` 回给来源，来源能 ack（不走交接绑定）；
//   * `armadra-hook mcp` 的 `tools/call canvas_handoff_read` 与 CLI 同一请求逐字节
//     同源。
//
// 不在本批：新开 Agent 作为目标、ACP 目标（见文件末尾的扩展点）。
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CREDENTIAL_VARIABLES, probeHome } from "../probe-home.mjs";
import { FAKE_AGENT } from "./scenario-12-acp.mjs";
import {
  blockRealClis,
  cleanups,
  note,
  root,
  scenario,
  sleep,
  startIsolatedCore,
  waitFor,
} from "./lib.mjs";
import {
  FIRST_ASK,
  LAST_ANSWER,
  claudeLines,
  codexLines,
  line,
  longClaudeLines,
  openCodeDatabase,
  piLines,
  writeLines,
} from "./handoff-fixtures.mjs";

const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/** 假 TUI：进程名由 `exec -a` 定；把收到的每个字节追加进日志，画一个提示符。 */
const FAKE_TUI = String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = process.argv[2];
process.stdout.write("fake tui ready\r\n> ");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  appendFileSync(log, chunk.toString("utf8"));
  process.stdout.write("\r\n> ");
});
`;

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=probe", "-c", "user.email=probe@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/* --------------------------------- 装配 --------------------------------- */

async function setupWorld() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-ho-")));
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const home = probeHome("armadra-ho-home-");
  cleanups.push(home.remove);
  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# probe\n");
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "README.md");
  git(project, "commit", "-q", "-m", "init");

  const data = join(scratch, "rt");
  mkdirSync(data);
  const hook = join(root, "apps/desktop/out/cli/armadra-hook.js");
  if (!existsSync(hook)) throw new Error(`未构建：${hook}`);
  const blockedDir = join(scratch, "blocked-bin");
  const blocked = blockRealClis(blockedDir, join(scratch, "blocked.log"));
  const environment = {
    ...process.env,
    ...home.env,
    PATH: `${blockedDir}:${process.env.PATH ?? ""}`,
    ARMADRA_DATA_DIR: data,
    ARMADRA_SECRET_BACKEND: "file",
    ARMADRA_NO_GLOBAL_WRITES: "1",
  };
  for (const name of ["TMUX", "TMUX_PANE", ...CREDENTIAL_VARIABLES])
    delete environment[name];

  // ACP 来源：`claude-agent-acp` 换成假 ACP Agent（节点是真会话，转录是真时间线）。
  if (!existsSync(FAKE_AGENT))
    throw new Error(`没有假 ACP Agent：${FAKE_AGENT}（pnpm install）`);
  const shims = join(scratch, "shims");
  mkdirSync(shims);
  const acpShim = join(shims, "claude-agent-acp");
  writeFileSync(
    acpShim,
    `#!/bin/bash\nexec -a claude-agent-acp ${quote(process.execPath)} ${quote(FAKE_AGENT)} "$@"\n`,
  );
  chmodSync(acpShim, 0o755);
  environment.PATH = `${shims}:${environment.PATH}`;

  const { api, origin } = await startIsolatedCore({
    data,
    environment,
    logName: "core-handoff.log",
  });
  return {
    scratch,
    home: home.path,
    project,
    data,
    hook,
    blocked,
    api,
    origin,
  };
}

function endpointOf(data) {
  return Object.fromEntries(
    readFileSync(join(data, "hook-endpoint.env"), "utf8")
      .split("\n")
      .map((entry) => /^([A-Z_]+)='(.*)'$/.exec(entry))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

/** 以节点令牌向 hook 面上报一条（与 CLI 的 Hook 同一条路）。 */
function reportHook(data, provider, nodeId, payload) {
  const endpoint = endpointOf(data);
  const token = readFileSync(
    join(endpoint.ARMADRA_NODE_TOKEN_DIR, nodeId),
    "utf8",
  ).trim();
  const body = Buffer.from(JSON.stringify({ nodeId, version: 1, payload }));
  return new Promise((done, fail) => {
    const call = httpRequest(
      {
        ...(endpoint.ARMADRA_HOOK_SOCK
          ? { socketPath: endpoint.ARMADRA_HOOK_SOCK }
          : { host: "127.0.0.1", port: Number(endpoint.ARMADRA_HOOK_PORT) }),
        path: `/hook/${provider}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-armadra-hook-token": endpoint.ARMADRA_HOOK_TOKEN,
          "x-armadra-node-token": token,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          response.statusCode === 204
            ? done()
            : fail(
                new Error(
                  `hook ${response.statusCode} ${Buffer.concat(chunks)}`,
                ),
              ),
        );
      },
    );
    call.on("error", fail);
    call.end(body);
  });
}

/* --------------------------------- 场景 --------------------------------- */

export default async function run() {
  const s = scenario("16-handoff");
  try {
    const world = await setupWorld();
    const { api, data, hook, scratch, project, home } = world;
    note("交接场景就位", project);

    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-handoff",
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

    // 来源五个、目标两个（Codex 与非 Codex 各一）。
    const specs = [
      ["src-claude", "claude"],
      ["src-codex", "codex"],
      ["src-pi", "pi"],
      ["src-opencode", "opencode"],
      ["src-acp", "claude", "acp"],
      ["tgt-codex", "codex"],
      ["tgt-claude", "claude"],
    ];
    const nodes = Object.fromEntries(
      specs.map(([title, agent, driver], index) => [
        title,
        {
          id: randomUUID(),
          boardId: board.id,
          type: "terminal",
          title,
          color: "#0a84ff",
          position: { x: (index % 4) * 560, y: Math.floor(index / 4) * 400 },
          size: { width: 520, height: 330 },
          labels: [],
          note: "",
          data: {
            kind: "terminal",
            cwd: project,
            agent: { id: agent, ...(driver ? { driver } : {}) },
          },
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]),
    );
    const edges = [];
    for (const [title] of specs.slice(0, 5))
      for (const target of ["tgt-codex", "tgt-claude"])
        edges.push({
          id: randomUUID(),
          boardId: board.id,
          source: nodes[title].id,
          target: nodes[target].id,
          kind: "link",
          role: "peer",
          createdAt: stamp,
          updatedAt: stamp,
        });
    await api(documentPath, {
      method: "PUT",
      body: {
        expectedUpdatedAt: initial.board.updatedAt,
        nodes: Object.values(nodes),
        edges,
        viewport: { x: 0, y: 0, zoom: 0.4 },
        whiteboard: "",
      },
    });

    // 页面把画布上的边物化成每个节点的连线文档；探针替页面写（来源 ↔ 目标，双向）。
    const sourceTitles = specs.slice(0, 5).map(([title]) => title);
    const targetTitles = ["tgt-codex", "tgt-claude"];
    const linkDocument = (ids) =>
      api(`/api/workspaces/${workspace.id}/context-links/${ids.node.id}`, {
        method: "PUT",
        body: {
          links: ids.peers.map((peer) => ({
            id: peer.id,
            title: peer.title,
            kind: "node",
            role: "peer",
          })),
        },
      });
    for (const title of sourceTitles)
      await linkDocument({
        node: nodes[title],
        peers: targetTitles.map((target) => nodes[target]),
      });
    for (const title of targetTitles)
      await linkDocument({
        node: nodes[title],
        peers: sourceTitles.map((source) => nodes[source]),
      });

    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const one = (sql, ...params) => database.prepare(sql).get(...params);
    const all = (sql, ...params) => database.prepare(sql).all(...params);

    // 真终端会话：Codex 目标跑假 TUI（进程名 codex），其余是 /bin/sh。
    const tuiPath = join(scratch, "codex.cjs");
    writeFileSync(tuiPath, FAKE_TUI);
    const tuiLog = join(scratch, "codex-tui.log");
    const sessions = {};
    const startSession = async (title) => {
      const created = await api("/api/terminals", {
        method: "POST",
        body: {
          workspaceId: workspace.id,
          cwd: project,
          nodeId: nodes[title].id,
          agent: { id: nodes[title].data.agent.id },
          shell: "/bin/sh",
          // Codex 目标：shell 里跑假 TUI（不 exec，shell 留作父进程；前台进程的命令
          // 行里有 codex.cjs，与真 Codex 一样过「前台是这个 Agent」的门）。
          ...(title === "tgt-codex"
            ? {
                command: "/bin/sh",
                args: [
                  "-c",
                  `${quote(process.execPath)} ${quote(tuiPath)} ${quote(tuiLog)}; exit 0`,
                ],
              }
            : {}),
        },
      });
      await api(`/api/terminals/${created.id}/node-token/refresh`, {
        method: "POST",
      });
      const row = one(
        "SELECT id, generation, agent_id, status, backend_kind FROM terminal_sessions WHERE id = ?",
        created.id,
      );
      sessions[title] = { id: row.id, generation: Number(row.generation) };
      return row;
    };
    for (const [title] of specs) {
      if (title === "src-acp") continue;
      const row = await startSession(title);
      note(`会话 ${title}`, row);
    }
    /* ---------- 来源转录：夹具文件 / 库 / ACP 会话，经 Hook 上报 ---------- */

    const files = join(scratch, "transcripts");
    mkdirSync(files);
    const long = longClaudeLines(120);
    const transcripts = {
      "src-claude": writeLines(join(files, "claude.jsonl"), [
        ...claudeLines(),
        ...long,
      ]),
      "src-codex": writeLines(join(files, "codex.jsonl"), codexLines()),
      "src-pi": writeLines(join(files, "pi.jsonl"), piLines()),
    };
    const opencode = openCodeDatabase(
      join(home, ".local/share"),
      "ses-handoff-probe",
    );
    opencode.add("m1", 1000, "user", FIRST_ASK);
    opencode.add("m2", 2000, "assistant", LAST_ANSWER);

    await reportHook(data, "claude", nodes["src-claude"].id, {
      hook_event_name: "SessionStart",
      session_id: "claude-src",
      transcript_path: transcripts["src-claude"],
    });
    await reportHook(data, "codex", nodes["src-codex"].id, {
      hook_event_name: "SessionStart",
      session_id: "codex-src",
      transcript_path: transcripts["src-codex"],
    });
    await reportHook(data, "pi", nodes["src-pi"].id, {
      hook_event_name: "session_start",
      session_id: "pi-src",
      transcript_path: transcripts["src-pi"],
    });
    await reportHook(data, "opencode", nodes["src-opencode"].id, {
      type: "session.idle",
      properties: { sessionID: "ses-handoff-probe" },
    });

    // ACP 来源：假 ACP Agent 的真会话，转录是会话时间线。
    const acp = await api("/api/acp/sessions", {
      method: "POST",
      body: {
        workspaceId: workspace.id,
        nodeId: nodes["src-acp"].id,
        cwd: project,
        agentId: "claude",
        prompt: FIRST_ASK,
      },
    });
    await waitFor(
      "ACP 来源这一轮结束",
      () => {
        const status = one(
          "SELECT state, state_source, transcript_path FROM agent_status WHERE node_id = ?",
          nodes["src-acp"].id,
        );
        return status?.state === "done" && status.transcript_path
          ? status
          : undefined;
      },
      { timeout: 60_000, interval: 300 },
    );
    const acpRow = one(
      "SELECT id, generation FROM terminal_sessions WHERE id = ?",
      acp.id,
    );
    sessions["src-acp"] = {
      id: acpRow.id,
      generation: Number(acpRow.generation),
    };

    for (const title of [
      "src-claude",
      "src-codex",
      "src-pi",
      "src-opencode",
      "src-acp",
    ]) {
      const status = one(
        "SELECT verified, restored, transcript_path, session_id FROM agent_status WHERE node_id = ?",
        nodes[title].id,
      );
      s.check(
        `来源 ${title} 的状态是 verified 且报了转录`,
        status?.verified === 1 &&
          status.restored === 0 &&
          (status.transcript_path || status.session_id),
        status,
      );
    }

    /* ----------------------------- 客户端工具 ----------------------------- */

    const baseEnv = (title) => ({
      PATH: process.env.PATH,
      HOME: home,
      ARMADRA_NODE_ID: nodes[title].id,
      ARMADRA_ENDPOINT_FILE: join(data, "hook-endpoint.env"),
      ARMADRA_DATA_DIR: data,
      ARMADRA_SESSION_ID: sessions[title].id,
      ARMADRA_SESSION_GENERATION: String(sessions[title].generation),
    });
    const hookAs = (title, argv, extra = {}) =>
      new Promise((done) => {
        execFile(
          process.execPath,
          [hook, ...argv],
          { env: { ...baseEnv(title), ...extra }, timeout: 60_000 },
          (error, stdout, stderr) =>
            done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
        );
      });
    const canvasAs = (title, verb, ...args) =>
      hookAs(title, ["canvas", verb, ...args]);
    const readJson = (answer) => {
      try {
        return JSON.parse(answer.stdout);
      } catch {
        return undefined;
      }
    };
    const transcriptPage = async (title, id, ...args) => {
      const answer = await canvasAs(
        title,
        "handoff-read",
        "--id",
        id,
        "--part",
        "transcript",
        ...args,
      );
      return { answer, body: readJson(answer) };
    };
    const inboxOf = async (title) => {
      const answer = await canvasAs(title, "inbox", "--limit", "50");
      return answer;
    };

    const prepare = (source, target, goal, extra = {}) =>
      api(`/api/workspaces/${workspace.id}/handoffs`, {
        method: "POST",
        body: {
          sourceNodeId: nodes[source].id,
          sourceSessionId: sessions[source].id,
          sourceGeneration: sessions[source].generation,
          targetNodeId: nodes[target].id,
          targetSessionId: sessions[target].id,
          targetGeneration: sessions[target].generation,
          sections: { goal, ...(extra.sections ?? {}) },
          filePaths: [],
          byteBudget: 8192,
          includeTranscript: true,
        },
      });
    const accept = (view) =>
      api(
        `/api/workspaces/${workspace.id}/handoffs/${view.bundle.handoffId}/accept`,
        { method: "POST", body: { expectedDigest: view.digest } },
      );
    const handoffRow = (id) =>
      one("SELECT state, mailbox_id FROM agent_handoffs WHERE id = ?", id);

    /* ------------- 1. Claude → 非 Codex 目标：简报、JSON、确认 ------------- */

    const acceptance = "单测全绿；README 多一行说明";
    const claudeView = await prepare(
      "src-claude",
      "tgt-claude",
      "把登录页接上新接口",
      {
        sections: { acceptance, constraints: "不改数据库迁移" },
      },
    );
    s.check(
      "prepare 只出预览，目标收件箱还没有交接",
      claudeView.state === "prepared" &&
        claudeView.bundle.version === 2 &&
        claudeView.bundle.sourceCursor?.unit === "bytes" &&
        !(await inboxOf("tgt-claude")).stdout.includes("handoff:"),
      { state: claudeView.state, version: claudeView.bundle.version },
    );
    const claudeId = claudeView.bundle.handoffId;
    const earlyRead = await canvasAs(
      "tgt-claude",
      "handoff-read",
      "--id",
      claudeId,
    );
    s.check("未确认的交接目标读不到", earlyRead.code !== 0, earlyRead.stderr);
    const accepted = await accept(claudeView);
    s.check(
      "accept 后状态 queued，目标收件箱出现 handoff:<id>",
      accepted.state === "queued" &&
        (await inboxOf("tgt-claude")).stdout.includes(`handoff:${claudeId}`),
      { state: accepted.state },
    );
    const mailboxId = handoffRow(claudeId).mailbox_id;

    const brief = await canvasAs(
      "tgt-claude",
      "handoff-read",
      "--id",
      claudeId,
    );
    s.check(
      "缺省得 Markdown 任务简报，含目标、约束、完成标准",
      brief.code === 0 &&
        brief.stdout.startsWith("# 交接：把登录页接上新接口") &&
        brief.stdout.includes("## 完成标准") &&
        brief.stdout.includes(acceptance) &&
        brief.stdout.includes("## 约束") &&
        brief.stdout.includes("## 做完之后"),
      brief.stdout.slice(0, 200),
    );
    s.check(
      "非 Codex 目标的简报写 armadra-hook 命令",
      brief.stdout.includes(
        `armadra-hook canvas post --to ${nodes["src-claude"].id} --key handoff:${claudeId}:result`,
      ) &&
        brief.stdout.includes(`armadra-hook canvas ack --id ${mailboxId}`) &&
        !brief.stdout.includes("canvas_post("),
    );
    const bundleJson = readJson(
      await canvasAs(
        "tgt-claude",
        "handoff-read",
        "--id",
        claudeId,
        "--format",
        "json",
      ),
    );
    s.check(
      "--format json 得冻结包：version 2、带 sourceCursor、digest 与预览一致",
      bundleJson?.bundle?.version === 2 &&
        bundleJson.bundle.sourceCursor?.endOffset ===
          readFileSync(transcripts["src-claude"]).length &&
        bundleJson.digest === claudeView.digest,
      {
        version: bundleJson?.bundle?.version,
        cursor: bundleJson?.bundle?.sourceCursor,
      },
    );
    s.check(
      "读不等于确认：读了两遍状态仍是 queued",
      handoffRow(claudeId).state === "queued",
      handoffRow(claudeId),
    );

    /* ----------------------- 2. 来源转录：分页与冻结边界 ----------------------- */

    const appended = line({
      type: "assistant",
      message: { role: "assistant", content: "AFTER FREEZE" },
    });
    appendFileSync(transcripts["src-claude"], appended);

    const totalExpected = 4 + 120;
    const collected = [];
    let cursor;
    let pages = 0;
    let head;
    for (let guard = 0; guard < 50; guard += 1) {
      const { body } = await transcriptPage(
        "tgt-claude",
        claudeId,
        ...(cursor === undefined ? [] : ["--cursor", String(cursor)]),
      );
      if (body?.mode !== "entries") break;
      head ??= body;
      pages += 1;
      collected.push(...body.entries);
      if (body.done) break;
      cursor = body.nextCursor;
    }
    const numbers = collected
      .map((entry) => /message (\d+) /.exec(entry.text)?.[1])
      .filter((value) => value !== undefined)
      .map(Number);
    s.check(
      "默认分页：超过一页，游标连续、无重复无遗漏、读到冻结边界为止",
      pages > 1 &&
        collected.length === totalExpected &&
        numbers.length === 120 &&
        numbers.every((value, index) => value === index) &&
        !JSON.stringify(collected).includes("AFTER FREEZE"),
      { pages, entries: collected.length },
    );
    s.check(
      "页头写来源",
      head?.part === "transcript" &&
        head.source?.provider === "claude" &&
        head.source?.nodeTitle === "src-claude",
      head?.source,
    );
    const narrow = [];
    cursor = undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const { body } = await transcriptPage(
        "tgt-claude",
        claudeId,
        "--limit",
        "7",
        ...(cursor === undefined ? [] : ["--cursor", String(cursor)]),
      );
      if (body?.mode !== "entries") break;
      narrow.push(...body.entries);
      if (body.done) break;
      cursor = body.nextCursor;
    }
    s.check(
      "--limit 7 一页一页读，与整段读同一序列",
      JSON.stringify(narrow) === JSON.stringify(collected),
      { entries: narrow.length },
    );
    const rawLines = [];
    cursor = undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const { body } = await transcriptPage(
        "tgt-claude",
        claudeId,
        "--raw",
        ...(cursor === undefined ? [] : ["--cursor", String(cursor)]),
      );
      if (body?.mode !== "raw") break;
      rawLines.push(...body.rawLines);
      if (body.done) break;
      cursor = body.nextCursor;
    }
    const expectedRaw = [...claudeLines(), ...long].map((each) =>
      each.trimEnd(),
    );
    s.check(
      "--raw 返回冻结范围内的原行，不含冻结之后的追加",
      JSON.stringify(rawLines) === JSON.stringify(expectedRaw),
      { lines: rawLines.length, expected: expectedRaw.length },
    );

    // 改写前缀：退回冻结摘录并标 transcriptChanged。
    const original = readFileSync(transcripts["src-claude"], "utf8");
    writeFileSync(
      transcripts["src-claude"],
      original.replace(FIRST_ASK, "FIRST ASK REWRITTEN"),
    );
    const changed = await transcriptPage("tgt-claude", claudeId);
    s.check(
      "改写来源前缀：退回冻结摘录并标 transcriptChanged",
      changed.body?.mode === "excerpt" &&
        changed.body.transcriptChanged === true &&
        changed.body.done === true &&
        changed.body.transcriptExcerpt ===
          claudeView.bundle.transcriptExcerpt &&
        String(changed.body.transcriptExcerpt).includes(FIRST_ASK),
      { mode: changed.body?.mode, changed: changed.body?.transcriptChanged },
    );
    writeFileSync(transcripts["src-claude"], original);

    /* --------------- 3. 五种来源：条目形状一致（各一次交接） --------------- */

    const shapes = {};
    const handoffs = { "src-claude": claudeId };
    for (const title of ["src-codex", "src-pi", "src-opencode", "src-acp"]) {
      const view = await prepare(title, "tgt-claude", `来自 ${title}`);
      await accept(view);
      handoffs[title] = view.bundle.handoffId;
    }
    for (const title of [
      "src-claude",
      "src-codex",
      "src-pi",
      "src-opencode",
      "src-acp",
    ]) {
      const { body } = await transcriptPage(
        "tgt-claude",
        handoffs[title],
        ...(title === "src-claude" ? ["--limit", "4"] : []),
      );
      shapes[title] = body;
    }
    const shapeOk = (entry) =>
      ["user", "assistant", "system"].includes(entry.role) &&
      typeof entry.text === "string" &&
      Array.isArray(entry.tools) &&
      Array.isArray(entry.results) &&
      (entry.at === undefined ||
        typeof entry.at === "string" ||
        typeof entry.at === "number");
    for (const [title, body] of Object.entries(shapes)) {
      const entries = body?.entries ?? [];
      s.check(
        `${title} 的 --part transcript：每条是 {role, text, tools, results}（at 可无）`,
        body?.mode === "entries" &&
          entries.length >= 2 &&
          entries.every(shapeOk) &&
          entries[0].role === "user" &&
          entries[0].text.includes(FIRST_ASK) &&
          entries.some((entry) => entry.role === "assistant"),
        {
          mode: body?.mode,
          source: body?.source,
          first: entries[0],
          count: entries.length,
          reason: body?.reason,
        },
      );
    }
    s.check(
      "来源是谁只写在页头 source",
      shapes["src-codex"]?.source?.provider === "codex" &&
        shapes["src-pi"]?.source?.provider === "pi" &&
        shapes["src-opencode"]?.source?.provider === "opencode" &&
        shapes["src-acp"]?.source?.provider === "claude",
      Object.fromEntries(
        Object.entries(shapes).map(([k, v]) => [k, v?.source?.provider]),
      ),
    );
    for (const title of ["src-claude", "src-pi"]) {
      s.check(
        `${title} 的工具调用与结果经同一形状读出`,
        shapes[title].entries.some((entry) => entry.tools.length > 0) &&
          shapes[title].entries.some((entry) => entry.results.length > 0),
        shapes[title].entries.map((entry) => [entry.tools, entry.results]),
      );
    }
    // OpenCode 冻结之后库里多一条，读不到。
    opencode.add("m3", 3000, "user", "AFTER FREEZE");
    const opencodeAfter = await transcriptPage(
      "tgt-claude",
      handoffs["src-opencode"],
    );
    s.check(
      "OpenCode 冻结后库里追加的读不到",
      opencodeAfter.body?.mode === "entries" &&
        !JSON.stringify(opencodeAfter.body.entries).includes("AFTER FREEZE"),
    );

    /* ------------- 4. Codex 目标：简报写工具名、唤醒、确认、回传 ------------- */

    // 假 TUI 起来之后报一次「这一轮结束」：空闲的 Codex 才会被唤醒。
    await waitFor(
      "假 Codex TUI 起来",
      async () =>
        (
          await api(
            `/api/terminals/${sessions["tgt-codex"].id}/capture?lines=10&escapes=false`,
          )
        ).data.includes("fake tui ready") || undefined,
      { timeout: 20_000, interval: 200 },
    );
    await reportHook(data, "codex", nodes["tgt-codex"].id, {
      hook_event_name: "SessionStart",
      session_id: "codex-tgt",
    });
    await reportHook(data, "codex", nodes["tgt-codex"].id, {
      hook_event_name: "Stop",
      session_id: "codex-tgt",
    });
    await sleep(1500);
    const codexView = await prepare(
      "src-codex",
      "tgt-codex",
      "给 Codex 的任务",
      { sections: { acceptance: "测试通过" } },
    );
    const codexId = codexView.bundle.handoffId;
    await accept(codexView);
    const woke = await waitFor(
      "空闲的 Codex 目标收到唤醒行",
      () =>
        existsSync(tuiLog) &&
        readFileSync(tuiLog, "utf8").includes("armadra-hook canvas inbox")
          ? readFileSync(tuiLog, "utf8")
          : undefined,
      { timeout: 30_000, interval: 300 },
    ).catch(() => undefined);
    s.check(
      "accept 后空闲的目标终端里收到收件箱唤醒行",
      woke !== undefined && woke.includes("收件箱有 1 条新消息"),
      woke?.slice(0, 300) ??
        (existsSync(tuiLog) ? readFileSync(tuiLog, "utf8") : null),
    );
    const codexMailbox = handoffRow(codexId).mailbox_id;
    const codexBrief = await canvasAs(
      "tgt-codex",
      "handoff-read",
      "--id",
      codexId,
    );
    s.check(
      "Codex 目标的简报写 canvas_* 工具名，没有 armadra-hook 命令",
      codexBrief.code === 0 &&
        codexBrief.stdout.includes(
          `canvas_post(to="${nodes["src-codex"].id}", key="handoff:${codexId}:result"`,
        ) &&
        codexBrief.stdout.includes(`canvas_ack(id="${codexMailbox}")`) &&
        codexBrief.stdout.includes("canvas_handoff_read(") &&
        !codexBrief.stdout.includes("armadra-hook canvas"),
      codexBrief.stdout.slice(-400),
    );

    // 来源自己读被拒。
    const sourceRead = await canvasAs(
      "src-codex",
      "handoff-read",
      "--id",
      codexId,
    );
    const sourceTranscript = await canvasAs(
      "src-codex",
      "handoff-read",
      "--id",
      codexId,
      "--part",
      "transcript",
    );
    s.check(
      "来源自己读（简报与转录）被拒",
      sourceRead.code !== 0 && sourceTranscript.code !== 0,
      {
        brief: sourceRead.stderr || sourceRead.stdout,
        transcript: sourceTranscript.stderr,
      },
    );

    // 目标把结果回给来源，来源 ack。
    const posted = await canvasAs(
      "tgt-codex",
      "post",
      "--to",
      nodes["src-codex"].id,
      "--key",
      `handoff:${codexId}:result`,
      "--body",
      "完成；见 README；无后续",
    );
    s.check(
      "目标 post handoff:<id>:result 给来源",
      posted.code === 0,
      posted.stdout || posted.stderr,
    );
    const sourceInbox = await waitFor(
      "来源收件箱有结果",
      async () => {
        const answer = await inboxOf("src-codex");
        return answer.stdout.includes(`handoff:${codexId}:result`)
          ? answer
          : undefined;
      },
      { timeout: 15_000, interval: 300 },
    ).catch(() => undefined);
    s.check(
      "来源收件箱收到结果",
      sourceInbox !== undefined,
      sourceInbox?.stdout.slice(0, 300),
    );
    const resultRow = one(
      "SELECT id FROM agent_mailbox WHERE target_node_id = ? AND message_key = ?",
      nodes["src-codex"].id,
      `handoff:${codexId}:result`,
    );
    const resultAck = await canvasAs(
      "src-codex",
      "ack",
      "--id",
      resultRow?.id ?? "none",
    );
    s.check(
      "来源能 ack 结果消息（不走交接绑定），交接状态不因此改变",
      resultAck.code === 0 && handoffRow(codexId).state === "queued",
      {
        code: resultAck.code,
        out: resultAck.stdout || resultAck.stderr,
        state: handoffRow(codexId).state,
      },
    );

    // 目标 ack 才是确认。
    const ack = await canvasAs("tgt-codex", "ack", "--id", codexMailbox);
    s.check(
      "目标 ack 收件箱那条后状态 acknowledged",
      ack.code === 0 && handoffRow(codexId).state === "acknowledged",
      {
        code: ack.code,
        out: ack.stdout || ack.stderr,
        state: handoffRow(codexId).state,
      },
    );

    /* ------------------------- 5. MCP 与 CLI 同源 ------------------------- */

    const mcp = (title, calls) =>
      new Promise((done, fail) => {
        const child = spawn(process.execPath, [hook, "mcp"], {
          env: baseEnv(title),
          stdio: ["pipe", "pipe", "pipe"],
        });
        const out = [];
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.on("error", fail);
        child.on("close", () =>
          done(
            Buffer.concat(out)
              .toString("utf8")
              .split("\n")
              .filter((entry) => entry.trim() !== "")
              .map((entry) => JSON.parse(entry)),
          ),
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("close", () => clearTimeout(timer));
        calls.forEach((call, index) =>
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...call })}\n`,
          ),
        );
        child.stdin.end();
      });
    const cliBrief = await canvasAs(
      "tgt-claude",
      "handoff-read",
      "--id",
      claudeId,
    );
    const cliTranscript = await canvasAs(
      "tgt-claude",
      "handoff-read",
      "--id",
      handoffs["src-codex"],
      "--part",
      "transcript",
      "--limit",
      "2",
    );
    const replies = await mcp("tgt-claude", [
      {
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "0" },
        },
      },
      {
        method: "tools/call",
        params: { name: "canvas_handoff_read", arguments: { id: claudeId } },
      },
      {
        method: "tools/call",
        params: {
          name: "canvas_handoff_read",
          arguments: {
            id: handoffs["src-codex"],
            part: "transcript",
            limit: 2,
          },
        },
      },
    ]);
    const textOf = (reply) => reply?.result?.content?.[0]?.text;
    s.check(
      "MCP canvas_handoff_read（简报）与 CLI 逐字节一致",
      textOf(replies.find((r) => r.id === 2)) ===
        cliBrief.stdout.replace(/\n$/, "") ||
        textOf(replies.find((r) => r.id === 2)) === cliBrief.stdout,
      {
        mcp: textOf(replies.find((r) => r.id === 2))?.slice(0, 80),
        cli: cliBrief.stdout.slice(0, 80),
      },
    );
    s.check(
      "MCP canvas_handoff_read（part=transcript）与 CLI 逐字节一致",
      textOf(replies.find((r) => r.id === 3)) ===
        cliTranscript.stdout.replace(/\n$/, "") ||
        textOf(replies.find((r) => r.id === 3)) === cliTranscript.stdout,
      {
        mcp: textOf(replies.find((r) => r.id === 3))?.slice(0, 80),
        cli: cliTranscript.stdout.slice(0, 80),
      },
    );

    /* ----------------------------- 6. 撤回 ----------------------------- */

    const pendingView = await prepare("src-pi", "tgt-claude", "会被撤回的交接");
    const pendingId = pendingView.bundle.handoffId;
    await accept(pendingView);
    const beforeCancel = await canvasAs(
      "tgt-claude",
      "handoff-read",
      "--id",
      pendingId,
    );
    await api(`/api/workspaces/${workspace.id}/handoffs/${pendingId}/cancel`, {
      method: "POST",
      body: { expectedDigest: pendingView.digest },
    });
    const afterCancel = await canvasAs(
      "tgt-claude",
      "handoff-read",
      "--id",
      pendingId,
    );
    const afterCancelTranscript = await transcriptPage("tgt-claude", pendingId);
    s.check(
      "撤回前读得到，撤回后简报与转录都被拒，收件箱那条消失",
      beforeCancel.code === 0 &&
        afterCancel.code !== 0 &&
        afterCancelTranscript.answer.code !== 0 &&
        !(await inboxOf("tgt-claude")).stdout.includes(
          `handoff:${pendingId}`,
        ) &&
        handoffRow(pendingId).state === "cancelled",
      {
        state: handoffRow(pendingId).state,
        after: afterCancel.stderr || afterCancel.stdout,
      },
    );

    /* ---------------------------- 收尾检查 ---------------------------- */

    s.check(
      "整套 core 没有起过任何真 CLI",
      world.blocked().length === 0,
      world.blocked(),
    );
    const leftovers = all(
      "SELECT COUNT(*) AS n FROM agent_deliveries WHERE target_node_id IN (?, ?)",
      nodes["tgt-claude"].id,
      nodes["tgt-codex"].id,
    );
    note("agent_deliveries", leftovers);
    // 扩展点（H3）：新开 Agent 作为目标、ACP 目标——在这里照上面「目标」的写法加：
    // prepare 的 target 换成新节点 / ACP 会话，目标侧经 `armadra-hook mcp`（ACP 没有终
    // 端，用 MCP 工具）读，断言同一份简报与同一套分页。
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
