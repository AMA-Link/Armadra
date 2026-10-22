// 派发出的 Agent 节点的视图跟随用户的默认视图偏好（#456、#462）。
//
// 隔离的 core + 页面，ACP 入口是假 ACP Agent（`@armadra/agent` 自带的测试替身），
// 其余真 CLI 都被拦下的替身顶替，不起真 Agent、不花额度。协调者用
// `armadra-hook canvas team` 各派发 2 个 Claude 节点，三种情形：
//   1. 偏好「会话」且 ACP 适配器在：driver = acp，页面是会话视图，没有 xterm；
//   2. 偏好「终端」：driver = terminal，页面是终端体（有 xterm）；
//   3. 偏好「会话」但走不了 ACP：driver = terminal 且 view = session，页面
//      是会话体、没有 xterm，进程与启动行由 core 起（假程序被调用）。
// 并截图。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/dispatch-view-e2e.mjs [输出目录]
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { CREDENTIAL_VARIABLES, probeHome } from "./probe-home.mjs";
import {
  blockRealClis,
  canvasAsIn,
  cleanups,
  output,
  root,
  sleep,
  startIsolatedCore,
  startPageStack,
  waitFor,
} from "./agent-e2e/lib.mjs";

const FAKE_AGENT = join(
  root,
  "apps/desktop/node_modules/@armadra/agent/dist/drivers/acp/testing/fake-agent-main.js",
);
const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;
const failures = [];
const check = (name, ok, detail) => {
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(name);
};

async function main() {
  if (!existsSync(FAKE_AGENT))
    throw new Error(`没有假 ACP Agent：${FAKE_AGENT}`);
  mkdirSync(output, { recursive: true });
  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), "armadra-dispatch-")),
  );
  cleanups.push(() =>
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "README.md"), "# dispatch view\n");
  execFileSync("git", ["init", "-q", project]);

  // PATH 最前面：假的 claude-agent-acp，其余真 CLI 都换成会拒绝的替身。
  const shims = join(scratch, "bin");
  mkdirSync(shims);
  const acp = join(shims, "claude-agent-acp");
  writeFileSync(
    acp,
    `#!/bin/bash\nexec -a claude-agent-acp ${quote(process.execPath)} ${quote(FAKE_AGENT)} "$@"\n`,
  );
  chmodSync(acp, 0o755);
  const blocked = blockRealClis(shims, join(scratch, "blocked.log"), [
    "claude-agent-acp",
  ]);

  const data = join(scratch, "rt");
  mkdirSync(data);
  const probe = probeHome("armadra-dispatch-home-");
  cleanups.push(probe.remove);
  const environment = {
    ...process.env,
    ...probe.env,
    PATH: `${shims}:${process.env.PATH ?? ""}`,
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: "info",
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
    logName: "core-dispatch.log",
  });
  const context = {
    hook: join(root, "apps/desktop/out/cli/armadra-hook.js"),
    data,
    home: probe.path,
  };
  await api("/api/settings", {
    method: "PATCH",
    body: { terminal: { ecoMode: false } },
  });

  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: {
      name: "dispatch-view",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    },
  });
  const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const initial = await api(documentPath);
  const stamp = new Date().toISOString();
  const lead = {
    id: randomUUID(),
    boardId: board.id,
    type: "terminal",
    title: "coordinator",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 560, height: 420 },
    labels: [],
    note: "",
    data: { kind: "terminal", cwd: project },
    createdAt: stamp,
    updatedAt: stamp,
  };
  await api(documentPath, {
    method: "PUT",
    body: {
      expectedUpdatedAt: initial.board.updatedAt,
      nodes: [lead],
      edges: [],
      viewport: { x: 20, y: 20, zoom: 0.6 },
      whiteboard: "",
    },
  });
  // 节点令牌只签给有会话的终端节点。
  const session = await api("/api/terminals", {
    method: "POST",
    body: {
      workspaceId: workspace.id,
      cwd: project,
      nodeId: lead.id,
      shell: "/bin/sh",
    },
  });
  await api(`/api/terminals/${session.id}/node-token/refresh`, {
    method: "POST",
  });

  const agents = await api("/api/agents");
  check(
    "假的 claude-agent-acp 在这套 core 里算已安装",
    agents.find((agent) => agent.id === "claude")?.acp?.installed === true,
  );

  const stack = await startPageStack(environment);
  // Vite 第一次要预构建依赖：先请求一次，页面导航才不会撞上超时。
  await fetch(stack.web).catch(() => undefined);
  const page = await stack.open("dispatch");
  page.drain();

  /** 协调者派发 2 个 Agent；答新成员节点。 */
  async function dispatch(tag, agent = "claude") {
    const before = (await api(documentPath)).nodes.map((node) => node.id);
    const team = await canvasAsIn(
      context,
      lead.id,
      "team",
      "--member",
      `${agent}|${tag}-a|审查 src/a`,
      "--member",
      `${agent}|${tag}-b|审查 src/b`,
    );
    check(
      `${tag}: canvas team 成功`,
      team.code === 0,
      team.stderr.trim().slice(0, 200),
    );
    const document = await api(documentPath);
    const members = document.nodes.filter(
      (node) => node.id !== lead.id && !before.includes(node.id),
    );
    check(
      `${tag}: 画布上多了 2 个成员节点`,
      members.length === 2,
      members.length,
    );
    return members;
  }

  /** 页面上这几个节点的节点体。 */
  async function bodiesOf(members) {
    await page.navigate(
      `${stack.web}/?workspace=${workspace.id}&board=${board.id}`,
    );
    await page.settle();
    for (const node of members) {
      const selector = `.react-flow__node[data-id="${node.id}"] [data-driver]`;
      await page.waitFor(
        `return !!document.querySelector(${JSON.stringify(selector)});`,
        { what: `节点 ${node.data.agent.id} 的节点体`, timeout: 60_000 },
      );
    }
    await sleep(1500);
    return page.evaluate(`
      return ${JSON.stringify(members.map((node) => node.id))}.map((id) => {
        const body = document.querySelector('.react-flow__node[data-id="' + id + '"] [data-driver]');
        return {
          id,
          driver: body?.dataset.driver,
          body: body?.dataset.body ?? null,
          xterm: !!body?.querySelector('.xterm'),
        };
      });
    `);
  }

  // 偏好「会话」，ACP 适配器装了：ACP 会话视图（#456）。
  await api("/api/settings", {
    method: "PATCH",
    body: { agents: { defaultDriver: "acp" } },
  });
  const acpMembers = await dispatch("session");
  check(
    "会话偏好：两个成员的节点数据都写明 driver = acp",
    acpMembers.every((node) => node.data?.agent?.driver === "acp"),
    acpMembers.map((node) => node.data?.agent),
  );
  const sessionViews = await bodiesOf(acpMembers);
  check(
    "会话偏好：页面上两个成员都是会话视图（data-driver=acp，没有 xterm）",
    sessionViews.length === 2 &&
      sessionViews.every((view) => view.driver === "acp" && !view.xterm),
    sessionViews,
  );
  await page.capture("dispatch-default-view");

  // 偏好「终端」：所有入口终端驱动、终端体。
  await api("/api/settings", {
    method: "PATCH",
    body: { agents: { defaultDriver: "terminal" } },
  });
  const terminal = await dispatch("terminal");
  check(
    "终端偏好：节点数据 driver = terminal，没有 view",
    terminal.every(
      (node) =>
        node.data?.agent?.driver === "terminal" &&
        node.data?.agent?.view === undefined,
    ),
    terminal.map((node) => node.data?.agent),
  );
  const terminalViews = await bodiesOf(terminal);
  check(
    "终端偏好：页面上两个成员都是终端体（有 xterm，没有会话体）",
    terminalViews.length === 2 &&
      terminalViews.every(
        (view) =>
          view.driver === "terminal" && view.body === null && view.xterm,
      ),
    terminalViews,
  );
  await page.capture("dispatch-terminal-preference");

  // 偏好「会话」，但这个 Agent 走不了 ACP：终端驱动、会话体；没有终端表面，
  // 进程与启动行由 core 起（假 CLI 只记下被调用，不跑真实 Agent）。
  await api("/api/settings", {
    method: "PATCH",
    body: { agents: { defaultDriver: "acp" } },
  });
  // 自定义 Agent 用自己的启动程序（这里是只记下被调用的假程序）：留在终端驱动。
  const custom = join(shims, "echo-cli");
  writeFileSync(custom, "#!/bin/sh\nexec sleep 600\n");
  chmodSync(custom, 0o755);
  await api("/api/settings", {
    method: "PATCH",
    body: {
      agents: {
        custom: [
          {
            id: "custom:echo",
            label: "echo",
            launchCmd: custom,
            baseAgent: "claude",
          },
        ],
      },
    },
  });
  const bodyOnly = await dispatch("bodyonly", "custom:echo");
  check(
    "会话偏好、走不了 ACP：driver = terminal 且 view = session",
    bodyOnly.every(
      (node) =>
        node.data?.agent?.driver === "terminal" &&
        node.data?.agent?.view === "session",
    ),
    bodyOnly.map((node) => node.data?.agent),
  );
  const bodyViews = await bodiesOf(bodyOnly);
  check(
    "走不了 ACP：页面上是会话体，没有 xterm",
    bodyViews.length === 2 &&
      bodyViews.every(
        (view) =>
          view.driver === "terminal" && view.body === "session" && !view.xterm,
      ),
    bodyViews,
  );
  await page.capture("dispatch-session-body");
  const rows = await waitFor("两个会话体节点都有 core 起的会话", async () => {
    const list = await api(`/api/workspaces/${workspace.id}/sessions`);
    const mine = bodyOnly.map((node) =>
      (Array.isArray(list) ? list : []).find((row) => row.nodeId === node.id),
    );
    return mine.every(Boolean) ? mine : null;
  });
  // 没有终端表面，启动行是 core 敲进 shell 的：抓屏里能看到它。
  for (const row of rows) {
    await waitFor(
      `节点 ${row.title} 的 shell 里有 core 敲的启动行`,
      async () => {
        const shot = await api(
          `/api/terminals/${row.sessionId}/capture?lines=40`,
        );
        return String(shot.data).includes("echo-cli");
      },
    );
  }
  check("两个会话体节点的会话与启动行都由 core 起", rows.length === 2);
  // 其余真 CLI 都被拦下，没有哪一次起了真 Agent。
  // 终端体与会话体的启动行会调到被拦下的 claude 替身（exit 97），那不算真 CLI。
  const real = blocked().filter(
    (line) => !/ --(help|version)$/.test(line) && !line.startsWith("claude "),
  );
  check("没有起任何真 CLI（只有被拦下的替身被调用）", real.length === 0, real);
}

try {
  await main();
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.error(`  FAIL  ${error?.stack ?? error}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {}
  }
}
process.exit(failures.length === 0 ? 0 : 1);
