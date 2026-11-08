// 场景 17：终端 OpenCode 的权限请求在画布里答复（契约 §109，#857）。C 档。
//
// 用户把 OpenCode 的 bash 设成 `ask`（隔离 HOME 里的 opencode.json）：模型一调
// bash，OpenCode 的 TUI 就停在「Permission required」，注入的插件把
// `permission.asked` 报给 core（卡片）并写 `pending/<id>.json`。点「允许 / 拒绝」
// 走 `POST /api/approvals/<id>/answer`：core 写 `<id>.answer`，插件经 OpenCode 自己的
// 客户端回复这条权限。断言：
//   * 答复的 route 是 `file`（不是 `keys`、`none`），审计里也是；
//   * 允许：命令真的跑了（文件写出来）；拒绝：命令没跑；
//   * 两种答复之后 TUI 里都没有残留的「Permission required」。
//
// 自己起一套 core，不开页面：终端由 `POST /api/terminals` 带 nodeId 起，提示词用
// paste 接口敲进去。OpenCode 用隔离 HOME、自带的免费模型，不碰操作员的配置。
// 需要 `ARMADRA_E2E_REAL=1`。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CREDENTIAL_VARIABLES, probeHome } from "../probe-home.mjs";
import {
  blockRealClis,
  cleanups,
  cliEnvLines,
  note,
  prepareCliHomes,
  requireReal,
  scenario,
  sleep,
  startIsolatedCore,
  waitFor,
} from "./lib.mjs";

const quote = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/** 刷一次在线模型目录，挑一个免费模型（名字里带 free 的优先）。 */
function pickFreeModel(scratch, cli) {
  const lister = join(scratch, "opencode-models.sh");
  writeFileSync(
    lister,
    [
      "#!/bin/sh",
      ...cliEnvLines(scratch, "opencode", cli),
      `exec ${quote(cli.program)} models --refresh`,
      "",
    ].join("\n"),
  );
  chmodSync(lister, 0o755);
  let listed = [];
  try {
    listed = execFileSync(lister, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("opencode/"));
  } catch {
    // 读不到就按没有处理
  }
  return (
    process.env.ARMADRA_E2E_OPENCODE_MODEL ||
    listed.find((name) => name.endsWith("-free")) ||
    listed[0] ||
    cli.model
  );
}

/**
 * `ARMADRA_E2E_OC_ROUTE=keys`：用户关了画布答复（`hooks.replyApprovals`），插件不写
 * 请求文件，core 退回按键——验证按键兜底（Enter / Escape）与 route 为 keys。
 */
const WANT_ROUTE =
  process.env.ARMADRA_E2E_OC_ROUTE === "keys" ? "keys" : "file";

export default async function run17() {
  const s = scenario("17-opencode-approval");
  try {
    requireReal("场景 17 ");
    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "armadra-oc-approval-")),
    );
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const project = join(scratch, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q", project]);

    const cli = prepareCliHomes(scratch, {
      only: new Set(["opencode"]),
    }).opencode;
    if (cli.skip) {
      s.check("opencode：跳过", true, cli.skip);
      s.finish();
      return;
    }
    cli.model = pickFreeModel(scratch, cli);
    note("OpenCode 用的免费模型", cli.model);
    // 用户策略：bash 一律问。
    mkdirSync(join(cli.home, ".config/opencode"), { recursive: true });
    writeFileSync(
      join(cli.home, ".config/opencode/opencode.json"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: cli.model,
          autoupdate: false,
          permission: { bash: "ask" },
        },
        null,
        2,
      )}\n`,
    );
    const wrapper = join(scratch, "run-opencode.sh");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'launcher="$1"; shift',
        ...cliEnvLines(scratch, "opencode", cli),
        `exec \${launcher:+"$launcher"} ${quote(cli.program)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);

    const shims = join(scratch, "bin");
    mkdirSync(shims);
    const blocked = blockRealClis(shims, join(scratch, "blocked.log"), []);
    void blocked;

    const data = join(scratch, "rt");
    mkdirSync(data);
    const probe = probeHome("armadra-oc-approval-home-");
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
      logName: "core-oc-approval.log",
    });
    await api("/api/settings", {
      method: "PATCH",
      body: { terminal: { ecoMode: false } },
    });
    if (WANT_ROUTE === "keys")
      await api("/api/settings", {
        method: "PATCH",
        body: { hooks: { replyApprovals: false } },
      });
    await api("/api/agents/opencode/integration/install", {
      method: "POST",
    }).catch((error) => note("opencode 注入产物准备失败", error.message));
    const launcher = (await api("/api/agents")).find(
      (row) => row.id === "opencode",
    )?.launcher;
    s.check("行上有启动器", typeof launcher === "string", launcher);

    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-oc-approval",
        rootPath: project,
        permissions: { read: true, write: true, execute: true },
      },
    });
    const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
    const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
    const initial = await api(documentPath);
    const stamp = new Date().toISOString();
    const node = {
      id: randomUUID(),
      boardId: board.id,
      type: "terminal",
      title: "oc-approval",
      color: "#0a84ff",
      position: { x: 0, y: 0 },
      size: { width: 700, height: 540 },
      labels: [],
      note: "",
      data: { kind: "terminal", cwd: project, agent: { id: "opencode" } },
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
    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const one = (sql, ...params) => database.prepare(sql).get(...params);
    const rows = (sql, ...params) => database.prepare(sql).all(...params);
    const status = () =>
      one(
        "SELECT state, state_source, pending_id FROM agent_status WHERE node_id = ?",
        node.id,
      );

    const session = await api("/api/terminals", {
      method: "POST",
      body: {
        workspaceId: workspace.id,
        cwd: project,
        nodeId: node.id,
        agent: { id: "opencode" },
        command: wrapper,
        args: [launcher ?? ""],
      },
    });
    const screen = async () =>
      (await api(`/api/terminals/${session.id}/capture?lines=60`)).data ?? "";
    await waitFor(
      "OpenCode 输入框出现",
      async () => (/Ask anything/.test(await screen()) ? true : undefined),
      { timeout: 150_000, interval: 1000 },
    );
    await sleep(2000);

    for (const [decision, file, label] of [
      ["allow", "approved.txt", "允许"],
      ["deny", "denied.txt", "拒绝"],
    ]) {
      const target = join(project, file);
      await api(`/api/terminals/${session.id}/paste`, {
        method: "POST",
        body: {
          text: `Use the bash tool to run exactly this command and nothing else: node -e "require('fs').writeFileSync('${file}','hi')" — then reply with just DONE or DENIED.`,
          enter: true,
        },
      });
      note(`让 OpenCode 跑一条要审批的命令（${decision}）`);
      // 以审批行为准、不看状态：OpenCode 在权限询问期间还会报工具进度，状态可能
      // 已被后到的 working 盖掉，而这张卡仍在、答复仍然有效。
      const blockedRow = await waitFor(
        `${decision}：出现未答复的审批`,
        () => {
          const row = one(
            "SELECT id AS pending_id FROM agent_approvals WHERE node_id = ? AND answer IS NULL",
            node.id,
          );
          return row ?? undefined;
        },
        { timeout: 180_000, interval: 500 },
      ).catch(async (error) => {
        note(`${decision}：等不到 blocked 时的状态`, {
          status: status(),
          approvals: rows("SELECT id, answer FROM agent_approvals"),
          pending: existsSync(join(data, "pending"))
            ? readdirSync(join(data, "pending"))
            : [],
        });
        note(
          `${decision}：等不到 blocked 时的屏幕`,
          (await screen()).split("\n").filter(Boolean).slice(-14),
        );
        throw error;
      });
      s.check(`${decision}：出现未答复的审批`, true, blockedRow);
      s.check(
        `${decision}：请求文件${WANT_ROUTE === "file" ? "在" : "不在"} pending/ 里`,
        existsSync(join(data, "pending", `${blockedRow.pending_id}.json`)) ===
          (WANT_ROUTE === "file"),
      );
      s.check(
        `${decision}：TUI 停在 Permission required`,
        /Permission required/.test(await screen()),
      );
      const answered = await api(
        `/api/approvals/${blockedRow.pending_id}/answer`,
        { method: "POST", body: { decision, answeredBy: "probe" } },
      );
      note(`点了「${label}」`, { route: answered.route });
      s.check(
        `${decision}：答复的 route 是 ${WANT_ROUTE}`,
        answered.route === WANT_ROUTE,
        answered,
      );
      const left = await waitFor(
        `${decision}：TUI 离开 Permission required`,
        async () =>
          /Permission required/.test(await screen()) ? undefined : true,
        { timeout: 30_000, interval: 500 },
      ).catch(() => false);
      s.check(`${decision}：答复后 TUI 里没有残留的权限提示`, left === true);
      await sleep(decision === "allow" ? 8000 : 4000);
      const exists = existsSync(target);
      s.check(
        decision === "allow"
          ? "allow：命令真的跑了（文件写出来）"
          : "deny：命令没有跑（文件不存在）",
        decision === "allow" ? exists : !exists,
        { file: target, exists },
      );
      const audited = rows(
        "SELECT decision, accepted, route FROM agent_approval_audit WHERE approval_id = ?",
        blockedRow.pending_id,
      );
      s.check(
        `${decision}：审计 route 为 ${WANT_ROUTE}`,
        audited.some((row) => row.accepted === 1 && row.route === WANT_ROUTE),
        audited,
      );
      note(
        `${decision} 之后的屏幕`,
        (await screen()).split("\n").filter(Boolean).slice(-8),
      );
      // 等这一轮结束，再发下一条。
      await waitFor(
        "本轮结束",
        () => {
          const row = status();
          return row && row.state !== "blocked" && row.state !== "working"
            ? row
            : undefined;
        },
        { timeout: 120_000, interval: 1000 },
      ).catch(() => undefined);
      await sleep(1500);
    }
  } catch (error) {
    s.fail(error);
  }
  s.finish();
}
