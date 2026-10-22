// 派发出的 Agent 节点默认显示会话视图（#456）。
//
// 隔离的 core + 页面，ACP 入口是假 ACP Agent（`@armadra/agent` 自带的测试替身），
// 不起真 CLI、不花额度。协调者用 `armadra-hook canvas team` 派发 2 个 Claude
// 节点，断言：节点数据里写明 `driver: "acp"`、页面上这两个节点是会话视图
// （`data-driver="acp"`，没有 xterm），并截图。
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

  // 协调者派发 2 个 Agent。
  const team = await canvasAsIn(
    context,
    lead.id,
    "team",
    "--member",
    "claude|reviewer-a|审查 src/a",
    "--member",
    "claude|reviewer-b|审查 src/b",
  );
  check("canvas team 成功", team.code === 0, team.stderr.trim().slice(0, 200));

  const document = await api(documentPath);
  const members = document.nodes.filter((node) => node.id !== lead.id);
  check("画布上多了 2 个成员节点", members.length === 2, members.length);
  check(
    "两个成员的节点数据都写明 driver = acp",
    members.every((node) => node.data?.agent?.driver === "acp"),
    members.map((node) => node.data?.agent),
  );

  const stack = await startPageStack(environment);
  // Vite 第一次要预构建依赖：先请求一次，页面导航才不会撞上超时。
  await fetch(stack.web).catch(() => undefined);
  const page = await stack.open("dispatch");
  page.drain();
  await page.navigate(
    `${stack.web}/?workspace=${workspace.id}&board=${board.id}`,
  );
  await page.settle();
  for (const node of members) {
    const selector = `.react-flow__node[data-id="${node.id}"] [data-driver]`;
    await page.waitFor(
      `return !!document.querySelector(${JSON.stringify(selector)});`,
      {
        what: `节点 ${node.data.agent.id} 的节点体`,
        timeout: 60_000,
      },
    );
  }
  await sleep(1500);
  const views = await page.evaluate(`
    return ${JSON.stringify(members.map((node) => node.id))}.map((id) => {
      const body = document.querySelector('.react-flow__node[data-id="' + id + '"] [data-driver]');
      return { id, driver: body?.dataset.driver, xterm: !!body?.querySelector('.xterm') };
    });
  `);
  check(
    "页面上两个成员都是会话视图（data-driver=acp，没有 xterm）",
    views.length === 2 &&
      views.every((view) => view.driver === "acp" && !view.xterm),
    views,
  );
  await page.capture("dispatch-default-view");
  // core 开场探 `--help` / `--version` 只读能力，不算起会话。
  const calls = blocked().filter((line) => !/ --(help|version)$/.test(line));
  check("没有起任何真 CLI", calls.length === 0, calls.slice(0, 3));
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
