// 场景 13：时间线一致性（设计 acp-progressive-view B10，会话时间线 §8）。C 档。
//
// 同一条会话时间线（键是会话行 id，切驱动不换行），ACP、终端两种驱动轮流写，
// 两台「设备」同时看——各自订阅事件流、按页面同一份规则（共享层
// `applyTimelineFrame` / `applyTimelineSync`：顺序应用、缺口即 sync）维护本地状态——
// 然后在每个检查点比对设备与 core 的 `timeline.open`：条目 id、`rev`、内容与
// `head_seq` 逐项相同；同一条连接上收到的 `timeline.delta` 帧首尾相接（不丢、不重、
// 不乱序）。
//
//   1. ACP 第一轮：两台设备先订阅、再 `timeline.open`，一轮「回复 OK」，比对。
//   2. 设备 B 掉线（关事件流）期间 ACP 再跑一轮；B 重连后用 `timeline.sync(本地序号)`
//      补齐，比对。
//   3. 切到终端视图（`acp.driver`）：时间线上有 `driver_switched` 提示，两台设备
//      一致。真跑且是 Codex 时，再从一个普通终端节点 `canvas send` 一句话给它，等转录
//      来源把这一轮写进时间线（来源不是 `acp`），比对；Claude 的终端视图要经页面答信任
//      对话框（场景 12 做了），这里只记 skipped。
//   4. 切回 ACP，再跑一轮，比对；回合序号单调、序号只增。
//   5. core 重启（只结束自己起的那个进程，同一个数据目录再起）：两台设备改连新的
//      事件流、`sync` 补齐，比对；重启前的每个条目 id 还在，`head_seq` 不回退。
//
// 隔离与门：与场景 12 同一套装配（`selfTestPlan` / `realPlan`，临时 HOME、PATH 最前面
// 是隔离包装、其余真 CLI 是替身）。真跑要 `ARMADRA_E2E_REAL=1`，家族取
// `ARMADRA_E2E_TIMELINE_ONLY`（缺省 `claude,codex`），装不上的整家 skipped；
// `--self-test` 用假 ACP Agent 与假 TUI，不要登录、不联网、不花额度。
import { execFileSync } from "node:child_process";
import {
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
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { CREDENTIAL_VARIABLES, probeHome } from "../probe-home.mjs";

import {
  CHOSEN,
  FAKE_AGENT,
  quote,
  realPlan,
  selfTestPlan,
  writeScript,
} from "./scenario-12-acp.mjs";
import {
  blockRealClis,
  canvasAsIn,
  cleanups,
  note,
  promptViaApi,
  requireReal,
  root,
  scenario,
  selfTest,
  sleep,
  startIsolatedCore,
  waitFor,
  watchWorkspaceEvents,
} from "./lib.mjs";

const FAMILIES = (process.env.ARMADRA_E2E_TIMELINE_ONLY || "claude,codex")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id === "claude" || id === "codex");
const TASK = "Reply with just OK.";
const TERMINAL_TASK = "Reply with just TERMINAL-OK.";
const TURN_TIMEOUT = selfTest ? 30_000 : 120_000;

/** 键序无关的稳定序列化，拿来比内容。 */
const canon = (value) =>
  JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );

async function rpc(origin, name, input) {
  const response = await fetch(
    `${origin}/api/rpc/${name.replace(".", "/")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    },
  );
  const text = await response.text();
  const body = text === "" ? {} : JSON.parse(text);
  if (!response.ok) {
    const error = new Error(`${name} → ${response.status} ${text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return body.json;
}

/**
 * 一台设备：订阅事件流（先订阅、再 open，open 之前到的帧先攒着），按共享层规则应用。
 * 所有变更串在一条 promise 链上，保证帧按到达顺序处理、sync 不与帧交叠。
 */
class Device {
  constructor(name, shared, timelineId) {
    this.name = name;
    this.shared = shared;
    this.timelineId = timelineId;
    this.state = shared.emptyTimelineState();
    this.chain = Promise.resolve();
    this.buffer = [];
    this.opened = false;
    this.origin = undefined;
    this.workspaceId = undefined;
    this.watch = undefined;
    /** 每条连接一个数组：同一条连接上的帧必须首尾相接。 */
    this.epochs = [];
    this.gaps = 0;
    this.duplicates = 0;
    this.syncs = 0;
  }

  /** 订阅事件流（不 open）。 */
  async subscribe(origin, workspaceId) {
    this.origin = origin;
    this.workspaceId = workspaceId;
    this.opened = false;
    this.buffer = [];
    const epoch = [];
    this.epochs.push(epoch);
    this.watch = await watchWorkspaceEvents(origin, workspaceId, (event) => {
      if (
        event?.type !== "timeline.delta" ||
        event.timelineId !== this.timelineId
      )
        return;
      epoch.push({ from: event.from, to: event.to });
      this.enqueue(() => this.receive(event));
    });
  }

  enqueue(work) {
    this.chain = this.chain.then(work).catch((error) => {
      this.failure ??= error;
    });
    return this.chain;
  }

  async receive(frame) {
    if (!this.opened) {
      this.buffer.push(frame);
      return;
    }
    const result = this.shared.applyTimelineFrame(this.state, frame);
    if (result.outcome === "duplicate") this.duplicates += 1;
    if (result.outcome === "gap") {
      this.gaps += 1;
      await this.sync();
      return;
    }
    this.state = result.state;
  }

  /** 首次打开：整份快照，再把攒着的帧按规则补上。 */
  async open() {
    await this.enqueue(async () => {
      try {
        const snapshot = await rpc(this.origin, "timeline.open", {
          timelineId: this.timelineId,
          tailTurns: 50,
        });
        this.state = this.shared.timelineStateFrom(snapshot);
      } catch (error) {
        // 会话还没写过时间线：当作空，靠帧长起来。
        if (error.status !== 404) throw error;
        this.state = this.shared.emptyTimelineState();
      }
      this.opened = true;
      const buffered = this.buffer;
      this.buffer = [];
      for (const frame of buffered) await this.receive(frame);
    });
  }

  async sync() {
    this.syncs += 1;
    const result = await rpc(this.origin, "timeline.sync", {
      timelineId: this.timelineId,
      after: this.state.seq,
    });
    this.state = this.shared.applyTimelineSync(this.state, result);
  }

  /** 掉线：关事件流，之后到的帧都收不到。 */
  disconnect() {
    this.watch?.close();
    this.watch = undefined;
  }

  /** 重连（可换新的源地址）：先订阅，再按本地序号补一次。 */
  async reconnect(origin, workspaceId) {
    await this.enqueue(async () => {
      this.opened = false;
      this.buffer = [];
    });
    await this.subscribe(origin, workspaceId);
    await this.enqueue(async () => {
      await this.sync();
      this.opened = true;
      const buffered = this.buffer;
      this.buffer = [];
      for (const frame of buffered) await this.receive(frame);
    });
  }

  items() {
    return this.shared.sortedTimelineItems(this.state);
  }

  /** 每条连接上的帧是否首尾相接。 */
  framesContiguous() {
    return this.epochs.every((epoch) =>
      epoch.every((frame, index) =>
        index === 0 ? true : frame.from === epoch[index - 1].to,
      ),
    );
  }
}

export default async function run13() {
  const s = scenario("13-timeline");
  const families = (s.families = {});
  const mark = (id, step, ok, detail) => {
    families[id] ??= {};
    families[id][step] = ok ? "passed" : `failed${detail ? `: ${JSON.stringify(detail).slice(0, 300)}` : ""}`;
    return s.check(`${id}：${step}`, ok, detail);
  };
  const savedChosen = [...CHOSEN];
  try {
    requireReal("场景 13 ");
    if (!existsSync(FAKE_AGENT) && selfTest)
      throw new Error(`没有假 ACP Agent：${FAKE_AGENT}（pnpm install）`);
    const shared = await import(
      pathToFileURL(join(root, "packages/shared/dist/index.js")).href
    );

    // 场景 12 的装配按 CHOSEN 选家；这里只要 claude / codex。
    CHOSEN.clear();
    for (const id of FAMILIES) CHOSEN.add(id);

    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "armadra-timeline-")),
    );
    cleanups.push(() =>
      rmSync(scratch, { recursive: true, force: true, maxRetries: 20 }),
    );
    const project = join(scratch, "project");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "# timeline probe\n");
    execFileSync("git", ["init", "-q", project]);

    const shims = join(scratch, "bin");
    mkdirSync(shims);
    const { plan, kept } = selfTest
      ? selfTestPlan(scratch, shims)
      : realPlan(scratch, shims, project);
    // 终端视图里的 codex：自检用假 TUI（场景 12 的计划只给 claude / copilot 配了）。
    const blocked = blockRealClis(shims, join(scratch, "blocked.log"), kept);
    if (selfTest)
      writeScript(shims, "codex", [
        `exec -a codex ${quote(process.execPath)} ${quote(join(scratch, "fake-tui.cjs"))} codex "$@"`,
      ]);
    const active = FAMILIES.filter((id) => plan[id]?.skip === undefined);
    for (const id of FAMILIES)
      if (plan[id]?.skip !== undefined) {
        families[id] = { skipped: plan[id].skip };
        s.check(`${id}：跳过`, true, plan[id].skip);
      }
    if (active.length === 0) throw new Error("claude 与 codex 都没装或认证不上");

    const data = join(scratch, "rt");
    mkdirSync(data);
    const probe = probeHome("armadra-timeline-home-");
    cleanups.push(probe.remove);
    const probeShell = writeScript(scratch, "probe-shell", [
      "unset CLAUDE_CONFIG_DIR",
      "export PS1='probe$ '",
      existsSync("/bin/zsh")
        ? 'exec /bin/zsh -f "$@"'
        : 'exec /bin/bash --noprofile --norc "$@"',
    ]);
    const environment = {
      ...process.env,
      ...probe.env,
      PATH: `${shims}:${process.env.PATH ?? ""}`,
      SHELL: probeShell,
      ARMADRA_DATA_DIR: data,
      ARMADRA_LOG: "info",
      ARMADRA_SECRET_BACKEND: "file",
      ARMADRA_NO_GLOBAL_WRITES: "1",
    };
    for (const name of ["TMUX", "TMUX_PANE", "CLAUDECODE", ...CREDENTIAL_VARIABLES])
      delete environment[name];
    for (const name of Object.keys(environment))
      if (/^(AMA_API_KEY_|ANTHROPIC_)/.test(name)) delete environment[name];

    let core = await startIsolatedCore({
      data,
      environment,
      logName: "core-timeline.log",
    });
    const hookContext = {
      hook: join(root, "apps/desktop/out/cli/armadra-hook.js"),
      data,
      home: probe.path,
    };
    // 重启后 core 换了端口：api 每次取当前的。
    const api = (...args) => core.api(...args);
    await api("/api/settings", {
      method: "PATCH",
      body: { terminal: { ecoMode: false } },
    });
    for (const id of active)
      await api(`/api/agents/${id}/integration/install`, {
        method: "POST",
      }).catch((error) => note(`${id} 注入产物准备失败`, error.message));

    /* ------------------------------- 画布 ------------------------------- */

    const workspace = await api("/api/workspaces", {
      method: "POST",
      body: {
        name: "agent-e2e-timeline",
        rootPath: project,
        permissions: { read: true, write: true, execute: true },
      },
    });
    const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
    const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
    const initial = await api(documentPath);
    const stamp = new Date().toISOString();
    const node = (id, title, x, agent) => ({
      id,
      boardId: board.id,
      type: "terminal",
      title,
      color: "#0a84ff",
      position: { x, y: 0 },
      size: { width: 600, height: 540 },
      labels: [],
      note: "",
      data: {
        kind: "terminal",
        cwd: project,
        ...(agent === undefined ? {} : { agent }),
      },
      createdAt: stamp,
      updatedAt: stamp,
    });
    const nodes = Object.fromEntries(
      active.map((id, index) => [
        id,
        node(randomUUID(), `timeline-${id}`, index * 640, {
          id,
          driver: "acp",
          ...(id === "claude" ? { permissionMode: "auto-edit" } : {}),
        }),
      ]),
    );
    const sender = node(randomUUID(), "timeline-sender", active.length * 640);
    await api(documentPath, {
      method: "PUT",
      body: {
        expectedUpdatedAt: initial.board.updatedAt,
        nodes: [...Object.values(nodes), sender],
        edges: Object.values(nodes).map((target) => ({
          id: randomUUID(),
          boardId: board.id,
          source: sender.id,
          target: target.id,
          kind: "link",
          role: "peer",
          createdAt: stamp,
          updatedAt: stamp,
        })),
        viewport: { x: 20, y: 20, zoom: 0.5 },
        whiteboard: "",
      },
    });

    const database = new DatabaseSync(join(data, "canvas.db"), {
      readOnly: true,
    });
    cleanups.push(() => database.close());
    const sessionRow = (nodeId) =>
      database
        .prepare(
          "SELECT id, backend_kind, status FROM terminal_sessions WHERE owner_node_id = ? ORDER BY (status = 'running') DESC, generation DESC LIMIT 1",
        )
        .get(nodeId);

    const driverEvents = [];
    let driverWatch;
    const watchDriver = async () => {
      driverWatch?.close();
      driverWatch = await watchWorkspaceEvents(core.origin, workspace.id, (event) => {
        if (event?.type === "acp.driver") driverEvents.push(event);
      });
    };
    await watchDriver();
    cleanups.push(() => driverWatch?.close());

    /* ------------------------------ 工具函数 ------------------------------ */

    const serverView = (timelineId) =>
      rpc(core.origin, "timeline.open", { timelineId, tailTurns: 50 });

    /** 等服务端时间线有至少 `count` 个回合、都收了尾、活动回到 idle。 */
    const waitTurns = async (timelineId, count, label) => {
      let last;
      try {
        return await waitFor(
          label,
          async () => {
            const view = await serverView(timelineId).catch((error) => {
              last = error.message;
              return undefined;
            });
            if (view === undefined) return undefined;
            last = {
              items: view.items.map((item) => `${item.kind}:${item.endedAt ?? ""}`),
              phase: view.activity?.phase,
            };
            const turns = view.items.filter((item) => item.kind === "turn");
            return turns.length >= count &&
              turns.every((turn) => turn.endedAt !== undefined) &&
              view.activity?.phase === "idle"
              ? view
              : undefined;
          },
          { timeout: TURN_TIMEOUT, interval: 300 },
        );
      } catch (error) {
        throw new Error(`${error.message}；最后看到 ${JSON.stringify(last)}`);
      }
    };

    /** 设备与 core 逐项比对；设备还在追的时候最多等 15 秒。 */
    const compare = async (id, label, timelineId, devices) => {
      let detail;
      const equal = async () => {
        const view = await serverView(timelineId);
        const truth = new Map(view.items.map((item) => [item.id, item]));
        for (const device of devices) {
          await device.chain;
          if (device.failure !== undefined) throw device.failure;
          const own = device.items();
          if (device.state.seq !== view.headSeq) {
            detail = { device: device.name, seq: device.state.seq, head: view.headSeq };
            return false;
          }
          if (own.length !== truth.size) {
            detail = { device: device.name, items: own.length, expected: truth.size };
            return false;
          }
          for (const item of own) {
            if (canon(item) !== canon(truth.get(item.id))) {
              detail = { device: device.name, item: item.id };
              return false;
            }
          }
        }
        return view;
      };
      try {
        const view = await waitFor(label, equal, {
          timeout: 15_000,
          interval: 250,
        });
        const contiguous = devices.every((device) => device.framesContiguous());
        return mark(id, label, contiguous, {
          headSeq: view.headSeq,
          items: view.items.length,
          contiguous,
          devices: devices.map((device) => ({
            name: device.name,
            syncs: device.syncs,
            gaps: device.gaps,
            duplicates: device.duplicates,
          })),
        })
          ? view
          : undefined;
      } catch (error) {
        mark(id, label, false, detail ?? error.message);
        return undefined;
      }
    };

    /* -------------------------------- 每家 -------------------------------- */

    for (const id of active) {
      const nodeId = nodes[id].id;
      let timelineId;
      let devices = [];
      try {
        const session = await api("/api/acp/sessions", {
          method: "POST",
          body: {
            workspaceId: workspace.id,
            nodeId,
            cwd: project,
            agentId: id,
            ...(id === "claude" ? { permissionMode: "auto-edit" } : {}),
          },
        });
        timelineId = session.id;
        const a = new Device("A", shared, timelineId);
        const b = new Device("B", shared, timelineId);
        devices = [a, b];
        // 先订阅、再 open。
        await a.subscribe(core.origin, workspace.id);
        await b.subscribe(core.origin, workspace.id);
        await a.open();
        await b.open();

        /* 1. ACP 第一轮 */
        await promptViaApi(api, timelineId, TASK);
        await waitTurns(timelineId, 1, "acp 第一轮");
        const first = await compare(id, "acp 第一轮两端一致", timelineId, devices);
        mark(
          id,
          "第一轮有用户消息与助手回复",
          first?.items.some((item) => item.kind === "user") &&
            first.items.some((item) => item.kind === "assistant"),
        );

        /* 2. B 掉线期间再跑一轮 */
        b.disconnect();
        const before = b.state.seq;
        await promptViaApi(api, timelineId, TASK);
        await waitTurns(timelineId, 2, "acp 第二轮");
        const head = (await serverView(timelineId)).headSeq;
        mark(id, "B 掉线期间 core 的序号往前走了", head > before, { before, head });
        await b.reconnect(core.origin, workspace.id);
        await compare(id, "B 掉线重连后两端一致", timelineId, devices);

        /* 3. 切到终端视图 */
        const switched = driverEvents.length;
        await api(`/api/acp/nodes/${nodeId}/driver`, {
          method: "POST",
          body: { driver: "terminal" },
        });
        const toTerminal = await waitFor(
          `${id} 切到终端的 acp.driver`,
          () =>
            driverEvents
              .slice(switched)
              .find((event) => event.nodeId === nodeId && event.driver === "terminal"),
          { timeout: 60_000, interval: 250 },
        );
        const terminal = await waitFor(
          `${id} 换成终端驱动`,
          () => {
            const row = sessionRow(nodeId);
            return row?.backend_kind !== "acp" && row?.status === "running"
              ? row
              : undefined;
          },
          { timeout: 30_000, interval: 300 },
        );
        mark(id, "切到终端后会话行没换", terminal.id === timelineId, {
          resumed: toTerminal.resumed,
        });
        await sleep(1000);
        const afterSwitch = await compare(id, "切到终端后两端一致", timelineId, devices);
        mark(
          id,
          "时间线有 driver_switched 提示",
          afterSwitch?.items.some(
            (item) => item.kind === "notice" && item.code === "driver_switched",
          ),
        );

        let terminalTurn = false;
        if (!selfTest && id === "codex") {
          // 终端驱动写进来的一轮：转录来源（来源不是 acp）。
          const known = new Set(
            (await serverView(timelineId)).items.map((item) => item.id),
          );
          await canvasAsIn(hookContext, sender.id, "send", "--to", nodeId, "--body", TERMINAL_TASK);
          try {
            await waitFor(
              "终端驱动的一轮进了时间线",
              async () => {
                const view = await serverView(timelineId);
                return view.items.some(
                  (item) =>
                    !known.has(item.id) &&
                    item.kind === "user" &&
                    item.source !== "acp" &&
                    String(item.text ?? "").includes("TERMINAL-OK"),
                ) && view.activity?.phase === "idle"
                  ? view
                  : undefined;
              },
              { timeout: TURN_TIMEOUT, interval: 500 },
            );
            terminalTurn = true;
            await compare(id, "终端驱动那一轮之后两端一致", timelineId, devices);
          } catch (error) {
            mark(id, "终端驱动那一轮", false, error.message);
          }
        } else {
          families[id].terminalTurn = selfTest
            ? "skipped: 自检的假 TUI 不写转录"
            : "skipped: Claude 的信任对话框要经页面答，见场景 12";
        }

        /* 4. 切回 ACP，再跑一轮 */
        // 没确认在提示符上就先结束终端：切回时 core 会敲 `/exit` + 回车。
        if (!terminalTurn)
          await api(`/api/terminals/${terminal.id}/terminate`, {
            method: "POST",
          }).catch(() => undefined);
        const back = driverEvents.length;
        await api(`/api/acp/nodes/${nodeId}/driver`, {
          method: "POST",
          body: { driver: "acp" },
        });
        await waitFor(
          `${id} 切回 ACP 的 acp.driver`,
          () =>
            driverEvents
              .slice(back)
              .find((event) => event.nodeId === nodeId && event.driver === "acp"),
          { timeout: 60_000, interval: 250 },
        );
        await waitFor(
          `${id} 换回 ACP`,
          () => {
            const row = sessionRow(nodeId);
            return row?.backend_kind === "acp" && row.status === "running"
              ? row
              : undefined;
          },
          { timeout: 60_000, interval: 300 },
        );
        const turnsBefore = (await serverView(timelineId)).items.filter(
          (item) => item.kind === "turn",
        ).length;
        await promptViaApi(api, timelineId, TASK);
        await waitTurns(timelineId, turnsBefore + 1, "切回 ACP 后一轮");
        const afterBack = await compare(id, "切回 ACP 再跑一轮后两端一致", timelineId, devices);
        const turnNumbers = afterBack?.items
          .filter((item) => item.kind === "turn")
          .map((item) => item.turn);
        mark(
          id,
          "回合序号严格递增",
          turnNumbers !== undefined &&
            turnNumbers.every((n, index) => index === 0 || n > turnNumbers[index - 1]),
          turnNumbers,
        );

        /* 5. core 重启 */
        const preRestart = await serverView(timelineId);
        families[id].preRestart = { headSeq: preRestart.headSeq };
        for (const device of devices) device.disconnect();
        const old = core.process;
        old.kill("SIGTERM");
        await waitFor("旧 core 退出", () => old.exitCode !== null || old.signalCode !== null, {
          timeout: 30_000,
          interval: 100,
        });
        // 同一个数据目录再起；endpoints.json 先删，免得读到旧的。
        rmSync(join(data, "endpoints.json"), { force: true });
        core = await startIsolatedCore({
          data,
          environment,
          logName: `core-timeline-${id}-restarted.log`,
        });
        await watchDriver();
        for (const device of devices)
          await device.reconnect(core.origin, workspace.id);
        const after = await compare(id, "core 重启后两端一致", timelineId, devices);
        const afterById = new Map(after?.items.map((item) => [item.id, item]));
        mark(
          id,
          "重启后 head_seq 没回退、重启前的条目都在",
          after !== undefined &&
            after.headSeq >= preRestart.headSeq &&
            preRestart.items.every((item) => afterById.has(item.id)),
          { before: preRestart.headSeq, after: after?.headSeq },
        );
      } catch (error) {
        mark(id, "未抛错", false, error.message);
      } finally {
        for (const device of devices) device.disconnect();
      }
      // 下一家要一个活着的 core（上面重启过）：节点与会话行都在库里，互不影响。
    }

    const blockedCalls = blocked();
    s.check(
      "没有起任何没经隔离包装的真 CLI",
      blockedCalls.length === 0,
      blockedCalls.slice(0, 5),
    );
    note("时间线一致性", families);
  } catch (error) {
    s.fail(error);
  } finally {
    CHOSEN.clear();
    for (const id of savedChosen) CHOSEN.add(id);
  }
  s.finish();
}
