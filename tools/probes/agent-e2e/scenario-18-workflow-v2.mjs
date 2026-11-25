// 场景 18：工作流 v2 端到端（Issue #996，设计 multi-agent-workflow §2.6 / §2.8）。
//
// 不用真 CLI、不用真模型：自己起一套 core（临时数据目录、临时 HOME），注册一个
// 自定义 Agent `custom:wfecho`（借 Claude 的 hook 适配）。它是本脚本写出的假 CLI：
// 读一行提示词，经 `armadra-hook claude` 报一轮；提示词带 `VERIFYME-ONCE` 时第一次
// 用 `canvas workflow-verdict --issue` 报不通过、之后 `--pass`，带 `VERIFYME-FAIL`
// 时永远报不通过，其余提示词一律 `canvas post` 给汇总角色。
//
// 断言：
//   * 两个角色 + 带 `verify` 的 `collect`：第一轮被退回（来源步骤 `round` 为 1），
//     第二轮通过，运行 `succeeded`；
//   * 收件箱键与条数：`workflow:<runId>:verify:s2:0` 与 `:1`、共享约定
//     `workflow:<runId>:contract:0`、汇总角色自己两轮各一条来源 `post`（来源步骤已经
//     `post` 给汇总角色，`gather` 不再放第二份，所以没有 `s1:1:0` 那种键）；
//   * 汇总角色每次被别的投递占着驱动租约，最多等 120 秒才轮到下一条，所以整个
//     场景要四五分钟，等待上限放到 420 秒（轮末释放租约 #1011 之后 CI 实测
//     仍超过 240 秒，上限暂不收回）；
//   * `maxRetries: 0`：第一次不通过就升级成关卡（`waiting`，`reason = verifyFailed`），
//     人 `approve` 之后运行 `succeeded`；
//   * `.ama/workflows` 往返：文件列表、导入、导出再列出，导入的模板带 `fileRef`。
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

import {
  cleanups,
  note,
  scenario,
  startIsolatedCore,
  waitFor,
} from "./lib.mjs";

const FAKE_CLI = String.raw`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const hook = __HOOK__;
const counter = __COUNTER__;
const target = __TARGET__;
const trace = __TRACE__;
const session = "wfv2-" + process.pid;
function report(event, extra) {
  spawnSync(hook, ["claude"], {
    input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: process.cwd(), ...(extra || {}) }),
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 10000,
  });
}
function canvas(args) {
  spawnSync(hook, ["canvas", ...args], { stdio: "ignore", timeout: 10000 });
}
report("SessionStart");
// 真 CLI 会读收件箱并确认；确认之前终端的驱动租约不放，排在后面的投递出不去。
setInterval(() => {
  const out = spawnSync(hook, ["canvas", "inbox"], { encoding: "utf8", timeout: 10000 });
  let messages = [];
  try {
    messages = JSON.parse(out.stdout).messages || [];
  } catch {}
  for (const message of messages) canvas(["ack", "--id", message.id]);
}, 3000);
process.stdout.write("wfv2 ready\n❯ \n");
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (raw) => {
  const line = raw.replace(/\x1b\[20[01]~/g, "").trim();
  if (line === "") return;
  fs.appendFileSync(trace, process.pid + " " + JSON.stringify(line.slice(0, 200)) + "\n");
  report("UserPromptSubmit", { prompt: line });
  if (line.includes("VERIFYME-FAIL")) {
    canvas(["workflow-verdict", "--issue", "coder: 不通过"]);
  } else if (line.includes("VERIFYME-ONCE")) {
    const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    fs.writeFileSync(counter, String(seen + 1));
    if (seen === 0) canvas(["workflow-verdict", "--issue", "coder: 缺测试"]);
    else canvas(["workflow-verdict", "--pass"]);
  } else if (/post to (\S+)/.test(line) || line.includes("请按下面的问题修改")) {
    const named = /post to (\S+)/.exec(line);
    const to = named ? named[1] : fs.existsSync(target) ? fs.readFileSync(target, "utf8").trim() : "";
    if (to !== "") canvas(["post", "--to", to, "--key", "wf-" + Date.now(), "--body", "done: " + line.slice(0, 80)]);
  }
  process.stdout.write("echo\n");
  setTimeout(() => {
    report("Stop");
    process.stdout.write("❯ \n");
  }, 500);
});
`;

const roles = [
  { id: "coder", agentId: "custom:wfecho" },
  { id: "reviewer", agentId: "custom:wfecho" },
];

const template = (title, prompt, extra) => ({
  version: 2,
  title,
  params: [],
  contract: { text: "共享约定：改动保持小而可审。" },
  roles,
  links: [{ from: "reviewer", to: "coder", role: "supervises" }],
  steps: [
    {
      id: "s1",
      kind: "prompt",
      role: "coder",
      prompt: "write the change and post to reviewer",
    },
    {
      id: "s2",
      kind: "collect",
      role: "reviewer",
      from: ["s1"],
      after: ["s1"],
      prompt,
      verify: { commands: ["true"] },
      ...extra,
    },
  ],
});

const FILE_TEXT = `---
version: 2
title: 文件里的流程
roles:
  - id: coder
    agentId: custom:wfecho
steps:
  - id: s1
    kind: prompt
    role: coder
    prompt: hello
---
`;

export default async function run() {
  const s = scenario("18-workflow-v2");
  try {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-wf2-")));
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const data = join(scratch, "rt");
    const home = join(scratch, "home");
    const project = join(scratch, "project");
    const bin = join(scratch, "bin");
    for (const dir of [data, home, project, bin]) mkdirSync(dir);
    const targetFile = join(scratch, "target");
    const counterFile = join(scratch, "counter");
    const fake = join(bin, "wfecho");
    // 路径写进脚本：core 替节点起的终端不带自定义 Agent 的 env。
    writeFileSync(
      fake,
      FAKE_CLI.replace(
        "__HOOK__",
        JSON.stringify(join(data, "bin", "armadra-hook")),
      )
        .replace("__COUNTER__", JSON.stringify(counterFile))
        .replace("__TARGET__", JSON.stringify(targetFile))
        .replace("__TRACE__", JSON.stringify(join(scratch, "trace.log"))),
    );
    chmodSync(fake, 0o755);
    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(scratch, "xdg"),
      XDG_DATA_HOME: join(scratch, "xdg-data"),
      CLAUDE_CONFIG_DIR: join(scratch, "claude"),
      CODEX_HOME: join(scratch, "codex"),
      ARMADRA_DATA_DIR: data,
      ARMADRA_SECRET_BACKEND: "file",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SHELL: "/bin/sh",
    };
    delete environment.TMUX;
    delete environment.TMUX_PANE;
    delete environment.CLAUDECODE;

    const { api } = await startIsolatedCore({
      data,
      environment,
      logName: "core-workflow-v2.log",
    });
    await waitFor(
      "armadra-hook",
      () => existsSync(join(data, "bin", "armadra-hook")),
      {
        timeout: 30_000,
        interval: 200,
      },
    );
    await api("/api/agents/claude/integration/install", { method: "POST" });
    await api("/api/settings", {
      method: "PATCH",
      body: {
        terminal: { ecoMode: false },
        agents: {
          custom: [
            {
              id: "custom:wfecho",
              label: "wfecho",
              launchCmd: fake,
              baseAgent: "claude",
            },
          ],
        },
      },
    });
    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "wf-v2",
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
    note("工作流 v2 场景就位", project);

    const finished = async (runId, accept) => {
      try {
        return await waitFor(
          `运行 ${runId} 到 ${accept.join("/")}`,
          async () => {
            const { run: current } = await api(`/api/workflows/runs/${runId}`);
            return accept.includes(current.status) ? current : undefined;
          },
          { timeout: 420_000, interval: 1000 },
        );
      } catch (error) {
        const { run: current } = await api(`/api/workflows/runs/${runId}`);
        let queue = [];
        try {
          const database = new DatabaseSync(join(data, "canvas.db"), {
            readOnly: true,
          });
          queue = database
            .prepare(
              "SELECT target_node_id, origin, state, last_reason, attempts, substr(body,1,80) AS body FROM agent_send_queue",
            )
            .all();
          queue.push(
            ...database
              .prepare(
                "SELECT node_id, state, state_source, session_phase FROM agent_status",
              )
              .all(),
          );
          database.close();
        } catch {}
        const trace = existsSync(join(scratch, "trace.log"))
          ? readFileSync(join(scratch, "trace.log"), "utf8")
          : "";
        throw new Error(
          `${error.message}；trace=${trace}；queue=${JSON.stringify(queue)}；${JSON.stringify({ status: current.status, steps: current.steps })}`,
        );
      }
    };
    const begin = async (draft) => {
      const { template: saved } = await api("/api/workflows/templates", {
        method: "POST",
        body: { template: draft },
      });
      const started = await api("/api/workflows/runs", {
        method: "POST",
        body: { templateId: saved.id, boardId: board.id },
      });
      writeFileSync(targetFile, started.run.roles.reviewer);
      return started.run;
    };
    const mailbox = (nodeId) => {
      const database = new DatabaseSync(join(data, "canvas.db"), {
        readOnly: true,
      });
      try {
        return database
          .prepare(
            "SELECT message_key FROM agent_mailbox WHERE target_node_id = ? ORDER BY sequence",
          )
          .all(nodeId)
          .map((row) => row.message_key);
      } finally {
        database.close();
      }
    };

    // 1. 第一轮退回、第二轮通过。
    const first = await begin(template("退回再通过", "VERIFYME-ONCE"));
    const passed = await finished(first.id, [
      "succeeded",
      "failed",
      "cancelled",
    ]);
    const s1 = passed.steps.find((step) => step.stepId === "s1");
    s.check(
      "第一轮退回、第二轮通过，运行 succeeded",
      passed.status === "succeeded",
      {
        status: passed.status,
        reason: passed.reason,
      },
    );
    s.check("来源步骤被退回重做一轮", s1?.round === 1, { round: s1?.round });
    const keys = mailbox(first.roles.reviewer);
    const wanted = [
      `workflow:${first.id}:contract:0`,
      `workflow:${first.id}:verify:s2:0`,
      `workflow:${first.id}:verify:s2:1`,
    ];
    const posts = keys.filter((key) => !key.startsWith("workflow:"));
    s.check(
      "收件箱有共享约定、两轮验证说明与两轮来源产出",
      wanted.every((key) => keys.includes(key)) && posts.length === 2,
      { keys },
    );
    s.check("每个键只有一条", new Set(keys).size === keys.length, {
      count: keys.length,
    });

    // 2. maxRetries: 0 → 关卡。
    const second = await begin(
      template("用尽升级", "VERIFYME-FAIL", { maxRetries: 0 }),
    );
    const waiting = await waitFor(
      "collect 升级成关卡",
      async () => {
        const { run: current } = await api(`/api/workflows/runs/${second.id}`);
        const step = current.steps.find((item) => item.stepId === "s2");
        return step?.status === "waiting" ? { current, step } : undefined;
      },
      { timeout: 420_000, interval: 1000 },
    );
    s.check(
      "maxRetries 0 升级成关卡，reason 为 verifyFailed",
      waiting.step.reason === "verifyFailed" &&
        waiting.current.status === "waiting",
      { reason: waiting.step.reason, status: waiting.current.status },
    );
    await api(`/api/workflows/runs/${second.id}/gates/s2`, {
      method: "POST",
      body: { decision: "approve" },
    });
    const accepted = await finished(second.id, [
      "succeeded",
      "failed",
      "cancelled",
    ]);
    s.check("人接受现状后运行 succeeded", accepted.status === "succeeded", {
      status: accepted.status,
    });

    // 3. .ama/workflows 往返。
    mkdirSync(join(project, ".ama", "workflows"), { recursive: true });
    writeFileSync(join(project, ".ama", "workflows", "hello.md"), FILE_TEXT);
    const listed = await api(
      `/api/workflows/files?workspaceId=${workspace.id}`,
    );
    s.check(
      "文件列表含有效的 hello",
      listed.files.some((file) => file.id === "hello" && file.valid),
      listed.files,
    );
    const imported = await api("/api/workflows/files/import", {
      method: "POST",
      body: { workspaceId: workspace.id, id: "hello" },
    });
    s.check(
      "导入建出带 fileRef 的模板",
      imported.change === "created" &&
        imported.template.fileRef === `${workspace.id}/hello`,
      { change: imported.change, fileRef: imported.template.fileRef },
    );
    const exported = await api(
      `/api/workflows/templates/${first.templateId}/export`,
      {
        method: "POST",
        body: { workspaceId: workspace.id, id: "exported" },
      },
    );
    const text = readFileSync(
      join(project, ".ama", "workflows", "exported.md"),
      "utf8",
    );
    s.check(
      "导出写出 ama 文件（version 2）",
      exported.id === "exported" && /^version: 2$/m.test(text),
      { path: exported.path },
    );
    const again = await api("/api/workflows/files/import", {
      method: "POST",
      body: { workspaceId: workspace.id, id: "exported" },
    });
    s.check("导出的文件再导入不改模板", again.change === "unchanged", {
      change: again.change,
    });
  } catch (error) {
    s.fail(error);
  } finally {
    s.finish();
  }
}
