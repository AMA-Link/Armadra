// 画布压力探针：30 个终端节点 + **真实会话**。
//
// 现有基线（`docs/history/canvas-react-flow.md` §6.5）的 30 个终端节点没有会话，
// 所以量不到用户报的卡顿——卡顿正出在「会话状态跳动 → `updateNodeData` → 换一份
// document → 全量重投影」这条链上（Armadra 画布初步分析；实测修正见 docs/status/canvas-performance-baseline.md §5.2）。
// 这个脚本把那一列补上：每个终端节点都真的连着一个 Runtime PTY 会话。
//
// 量七段：空闲 / 手形平移 / 拖一个节点 / ctrl+滚轮缩放 / 框选 / 在一张便签里连续
// 输入 100 字符 / 300 条墨迹白板板上平移。每段记平均 fps、p50、p95 帧时、最慢一帧、
// 超过 33.4 ms 的帧数、长任务数、主线程脚本+布局+样式耗时、任务总耗时、JS 堆与
// DOM 节点数。
//
// 手势段另记输入到出帧的延迟（每个 pointermove / wheel 到它引起的舞台变动上屏
// 那一帧），这是比较用的响应指标；fps 只记录（不封顶时它数的是每个输入出了几帧）。
// 默认不封顶：Chrome 带 `--disable-gpu-vsync --disable-frame-rate-limit`，rAF 不再
// 被 60 Hz 卡住，帧时才有判别力；主线程耗时与刷新率无关。`CANVAS_BENCH_CAPPED=1`
// 退回旧的 60 Hz 封顶。每段的输入是固定步数（不是固定时长），两个引擎吃到同一串输入。
// 对比：`canvas-bench-aggregate.mjs` 取多次中位数做基线，`canvas-bench-compare.mjs`
// 逐项比较（未严格优于基线即退出码 1；floor / 持平 / 波动内三类例外见 lib）。
// 另外单独量一次「一次会话状态跳动引发多少个组件重渲」：注入 React DevTools
// 的 hook 垫片（React 只有在 hook 在它之前就位时才给 fiber 打开 ProfileMode），
// 用 DevTools Profiler 自己那条 `didFiberRender` 判据数 fiber。
//
// 跑的是一整条真链路：临时数据目录里的 core、一个临时工作空间、Vite
// 开发服务器、新 profile 的无头 Chrome，页面是应用自己的首页（`?workspace=…&board=…`
// 深链，见 `apps/web/src/app/use-board-sync.ts`）。端口随机（不用 1420 / 1421 /
// 43120 / 43121），数据目录与浏览器 profile 都是 mktemp 出来的，跑完删除；不读写
// 操作员自己的数据目录、凭据或任何远端。
//
// 用法（仓库根目录）：
//   export CARGO_TARGET_DIR=$PWD/target
//   pnpm --filter @armadra/desktop build
//   node tools/probes/canvas-stress.mjs [输出目录] [节点数]
//
// 产物：<输出目录>/result.json 与 canvas.png。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  CANVAS_DOM,
  SCHEMA,
  SELECTORS,
  buildInkWhiteboardV3,
  diffPerformance,
  metricsMap,
  summarizeFrames,
  summarizeLatency,
} from "./canvas-bench-lib.mjs";
import { isolatedEnv, probeHome } from "./probe-home.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const dom = CANVAS_DOM;
const output = resolve(positional[0] ?? join(root, "target/canvas-stress"));
const terminalCount = Number(positional[1] ?? 30);
mkdirSync(output, { recursive: true });

const PAN_STEPS = 900;
const DRAG_STEPS = 540;
const ZOOM_STEPS = 24;
const SELECT_STEPS = 240;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const capped = process.env.CANVAS_BENCH_CAPPED === "1";
const traceSegments = (process.env.CANVAS_BENCH_TRACE ?? "").split(",");
const traceEvents = [];
const reactSegments = (process.env.CANVAS_BENCH_REACT ?? "").split(",");
const profileSegments = (process.env.CANVAS_BENCH_PROFILE ?? "").split(",");
const report = {
  schema: SCHEMA,
  status: "failed",
  capped,
  terminals: terminalCount,
  liveSessions: 0,
  segments: {},
  rerender: null,
  steps: [],
  output,
};

function step(name, detail = "") {
  report.steps.push({ name, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return [1420, 1421, 43120, 43121].includes(port) ? freePort() : port;
}

/* --------------------------- 页面里的两台仪器 --------------------------- */

/**
 * 帧计时器 + 重渲计数器，必须在页面任何脚本之前就位。
 *
 * 重渲计数抄 React DevTools 的判据（`react-devtools-shared` 的 `didFiberRender`）：
 * 函数/类/forwardRef/memo 看 `PerformedWork` 标志位，其余看 props / state / ref
 * 有没有换对象。`__REACT_DEVTOOLS_GLOBAL_HOOK__` 必须在 react-dom 初始化之前
 * 存在，否则 React 不会给 HostRoot 打开 ProfileMode，`flags` 也就无从谈起。
 */
const INSTRUMENT = `
(() => {
  const frames = { on: false, times: [] };
  // 输入到出帧的延迟：每个 pointermove / wheel 记下事件时间戳，等到画布舞台里
  // 第一次有相关的 DOM 变动，算到**那一变动上屏的那一帧**的 rAF 时间。变动发生在
  // 某一帧的 rAF 回调里（这个计时器的 rAF 永远排在页面的前面，先登记帧开始），就
  // 记这一帧；发生在帧外（输入回调、帧后的 React commit），就记下一帧。旧引擎在
  // 帧后提交、再补一帧才上屏，新引擎在同一帧里写完——fps 数的是帧数，这个数的是
  // 用户看到响应要等多久。
  const latency = {
    on: false,
    stage: null,
    pending: [],
    values: [],
    frameTime: 0,
    inFrame: false,
    outside: false,
  };
  const settle = (time) => {
    for (const stamp of latency.pending) latency.values.push(time - stamp);
    latency.pending.length = 0;
  };
  const frameEnd = new MessageChannel();
  frameEnd.port1.onmessage = () => {
    latency.inFrame = false;
  };
  const tick = (now) => {
    if (frames.on) frames.times.push(now);
    if (latency.on) {
      latency.frameTime = now;
      latency.inFrame = true;
      if (latency.outside) {
        latency.outside = false;
        settle(now);
      }
      frameEnd.port2.postMessage(0);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const onInput = (event) => {
    if (latency.on) latency.pending.push(event.timeStamp);
  };
  addEventListener("pointermove", onInput, { capture: true, passive: true });
  addEventListener("wheel", onInput, { capture: true, passive: true });
  new MutationObserver((records) => {
    if (!latency.on || latency.pending.length === 0) return;
    const relevant = records.some(
      (record) =>
        record.target.nodeType === 1 && record.target.closest(latency.stage),
    );
    if (!relevant) return;
    if (latency.inFrame) settle(latency.frameTime);
    else latency.outside = true;
  }).observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "transform", "x", "y", "width", "height", "d"],
  });

  const PERFORMED_WORK = 0b1;
  const RENDERING_TAGS = new Set([0, 1, 9, 11, 14, 15]); // Function/Class/ContextConsumer/ForwardRef/Memo/SimpleMemo
  const profiler = { on: false, commits: 0, byName: new Map(), roots: new Map(), perCommit: [] };

  function nameOf(fiber) {
    const type = fiber.type ?? fiber.elementType;
    if (typeof type === "function") return type.displayName || type.name || "anonymous";
    if (type && typeof type === "object") {
      return type.displayName || type.render?.name || type.type?.name || "memo";
    }
    return typeof type === "string" ? type : "host";
  }

  function didRender(previous, next) {
    if (RENDERING_TAGS.has(next.tag)) {
      return (next.flags & PERFORMED_WORK) === PERFORMED_WORK;
    }
    return (
      previous.memoizedProps !== next.memoizedProps ||
      previous.memoizedState !== next.memoizedState ||
      previous.ref !== next.ref
    );
  }

  function walk(root) {
    let seen = 0;
    // 只走这一次 commit 真正碰过的子树。React 在高层 bail out 时不克隆子节点，
    // workInProgress.child 就是上一棵树的那个对象——整条子树原封不动，里面的
    // flags 还留着它上次渲染时的 PerformedWork。不设这道门会把没渲染的子树
    // 全部数进来（实测多出一个数量级）。
    // 第三格：祖先里已经有人重渲了吗。没有的那一个就是这棵子树的**根因**，
    // 叶子（Popover 之类）只是被它带下水的。
    const stack = [[root.current, false, false]];
    while (stack.length > 0) {
      const [fiber, forced, underRendered] = stack.pop();
      if (!fiber) continue;
      const previous = fiber.alternate;
      const rendered = forced || !previous || didRender(previous, fiber);
      let nowUnder = underRendered;
      if (rendered && RENDERING_TAGS.has(fiber.tag)) {
        seen += 1;
        const key = nameOf(fiber);
        profiler.byName.set(key, (profiler.byName.get(key) ?? 0) + 1);
        if (!underRendered) {
          profiler.roots.set(key, (profiler.roots.get(key) ?? 0) + 1);
          nowUnder = true;
        }
      }
      // 子树与上一棵完全共享 = 这次没进去过。
      const shared = previous && fiber.child && fiber.child === previous.child;
      if (fiber.child && !shared) stack.push([fiber.child, false, nowUnder]);
      if (fiber.sibling) stack.push([fiber.sibling, false, underRendered]);
    }
    return seen;
  }

  let rendered = 0;
  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) {
      const id = hook.renderers.size + 1;
      hook.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_id, fiberRoot) {
      if (!profiler.on) return;
      profiler.commits += 1;
      const before = new Map(profiler.roots);
      const count = walk(fiberRoot);
      rendered += count;
      // 每次 commit 的规模与它的「头部嫌疑人」——只有这份分解能指出
      // 到底是谁在把三十个节点头一起拖下水。
      const delta = [];
      for (const [name, total] of profiler.roots) {
        const grew = total - (before.get(name) ?? 0);
        if (grew > 0) delta.push([name, grew]);
      }
      delta.sort((a, b) => b[1] - a[1]);
      profiler.perCommit.push({
        n: count,
        top: delta.slice(0, 4).map(([name, grew]) => name + ":" + grew),
      });
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    value: hook,
    configurable: false,
    writable: false,
  });

  const longTasks = { on: false, count: 0 };
  let longTaskObserver = null;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (longTasks.on) longTasks.count += list.getEntries().length;
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {}

  window.__armadraProbe = {
    startFrames(stage) {
      frames.times.length = 0;
      latency.stage = stage;
      latency.pending.length = 0;
      latency.values.length = 0;
      latency.outside = false;
      latency.on = true;
      longTasks.count = 0;
      longTasks.on = true;
      frames.on = true;
    },
    stopFrames() {
      frames.on = false;
      latency.on = false;
      if (longTaskObserver && longTasks.on) {
        longTasks.count += longTaskObserver.takeRecords().length;
      }
      longTasks.on = false;
      return {
        times: frames.times.slice(),
        longTasks: longTasks.count,
        latencies: latency.values.slice(),
      };
    },
    startProfiler() {
      profiler.commits = 0;
      profiler.byName.clear();
      profiler.roots.clear();
      profiler.perCommit.length = 0;
      rendered = 0;
      profiler.on = true;
    },
    stopProfiler() {
      profiler.on = false;
      const top = [...profiler.byName.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => ({ name, count }));
      const roots = [...profiler.roots.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count }));
      return { commits: profiler.commits, rendered, top, roots, perCommit: profiler.perCommit.slice(0, 60) };
    },
  };
})();
`;

/* -------------------------------- 画布内容 ------------------------------- */

/**
 * 每行 6 个，行距与列距留足，`fitView` 之后全部落在视口里——和既有基线
 * 一样，这是最坏情况：React Flow 不裁剪，30 个终端全在画。
 */
function seedNodes(boardId, count) {
  const stamp = new Date().toISOString();
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: randomUUID(),
      boardId,
      type: "terminal",
      title: `term-${index + 1}`,
      color: "#0a84ff",
      position: { x: (index % 6) * 420, y: Math.floor(index / 6) * 300 },
      size: { width: 380, height: 240 },
      labels: [],
      note: "",
      data: { kind: "terminal" },
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  nodes.push({
    id: randomUUID(),
    boardId,
    type: "sticky",
    title: "note",
    color: "#ffd60a",
    position: { x: 6 * 420, y: 0 },
    size: { width: 320, height: 220 },
    labels: [],
    note: "",
    data: { kind: "sticky", content: "" },
    createdAt: stamp,
    updatedAt: stamp,
  });
  return nodes;
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "armadra-stress-"));
  cleanups.push(() =>
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(workspace, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# probe\n");

  /* -------------------------------- Runtime ------------------------------ */

  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary)) {
    throw new Error(
      `core 未构建：${binary}。先跑 pnpm --filter @armadra/desktop build`,
    );
  }
  const data = join(workspace, "runtime");
  mkdirSync(data, { recursive: true });
  // core 关停时保留 tmux 会话；不先停掉服务器，删目录只会删掉 socket，shell 永远留着
  cleanups.push(() =>
    execFileSync("tmux", ["-S", join(data, "tmux.sock"), "kill-server"], {
      stdio: "ignore",
    }),
  );
  // 临时 HOME：core 不读操作员的 CLI 登录状态与配置。
  const home = probeHome("armadra-canvas-stress-home-");
  cleanups.push(home.remove);
  const environment = isolatedEnv(home, {
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
  });
  const runtime = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      env: environment,
    },
  );
  cleanups.push(() => runtime.kill("SIGKILL"));
  let diagnostics = "";
  runtime.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const endpoints = join(data, "endpoints.json");
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null) {
      throw new Error(`core 退出：${diagnostics}`);
    }
    try {
      origin = JSON.parse(readFileSync(endpoints, "utf8")).runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!(await fetch(new URL("/api/health", origin))).ok) {
    throw new Error("core 健康检查失败");
  }
  step("core 已启动", origin);

  const api = async (path, init) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!answer.ok) {
      throw new Error(`${path} → ${answer.status} ${await answer.text()}`);
    }
    return answer.json();
  };

  const created = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "stress",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${created.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${created.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "stress" }),
    }));
  const document = await api(
    `/api/workspaces/${created.id}/boards/${board.id}/document`,
  );
  const nodes = seedNodes(board.id, terminalCount);
  await api(`/api/workspaces/${created.id}/boards/${board.id}/document`, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: document.board.updatedAt,
      nodes,
      edges: [],
      // 既有基线的最坏情况：`scale 0.35`，所有节点都在视口里，React Flow
      // 不裁剪（`docs/history/canvas-react-flow.md` §6.5）。视口直接写进文档，
      // 不靠 `fitView`——那是个藏在下拉里的菜单项，脚本点不稳。
      viewport: { x: 280, y: 80, zoom: 0.35 },
      whiteboard: "",
    }),
  });
  step("节点就位", `${terminalCount} 个终端 + 1 张便签`);

  /* ---------------------------- Vite 开发服务器 -------------------------- */

  const port = await freePort();
  // 直接起 vite 可执行文件：经 pnpm 起会在临时 HOME 里重新拉一份 pnpm 本身，网络不好时一挂就是几十分钟。
  const vite = spawn(
    join(root, "apps/web/node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort"],
    {
      cwd: join(root, "apps/web"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, ARMADRA_DATA_DIR: data },
    },
  );
  cleanups.push(() => vite.kill("SIGKILL"));
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  const page = `http://127.0.0.1:${port}/?workspace=${created.id}&board=${board.id}`;
  for (let attempt = 0; attempt < 900 && !served; attempt += 1) {
    if (vite.exitCode !== null) throw new Error("Vite 退出");
    await sleep(100);
  }
  if (!served) throw new Error("Vite 未就绪");
  step("开发服务器已就绪", page);

  /* --------------------------------- Chrome ------------------------------ */

  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable)) {
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  }
  const profile = mkdtempSync(join(tmpdir(), "armadra-stress-profile-"));
  cleanups.push(() =>
    rmSync(profile, { recursive: true, force: true, maxRetries: 20 }),
  );
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--hide-scrollbars",
      // 不封顶：关垂直同步与帧率限制，rAF 才能跑过 60 Hz（CANVAS_BENCH_CAPPED=1 关掉）。
      ...(capped ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"]),
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  cleanups.push(() => browser.kill("SIGKILL"));
  let devtools = "";
  for (let attempt = 0; attempt < 300 && !devtools; attempt += 1) {
    try {
      devtools = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
        .split("\n")[0]
        .trim();
    } catch {
      await sleep(100);
    }
  }
  if (!devtools) throw new Error("Chrome 未开出调试端口");
  const version = await (
    await fetch(`http://127.0.0.1:${devtools}/json/version`)
  ).json();
  report.chrome = version["Browser"];
  const target = await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  cleanups.push(() => socket.close());
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = (sequence += 1);
      // 页面卡死（导航被确认框挡住、渲染进程挂起）时 CDP 永远不答：超时就让这一轮失败，
      // 而不是把整个基准挂上几十分钟。
      const timer = setTimeout(() => {
        pending.delete(id);
        // 取证：页面脚本死循环时 `Debugger.pause` 能打断它，把调用栈留下来。
        socket.send(
          JSON.stringify({ id: 9_000_001, method: "Debugger.enable" }),
        );
        socket.send(
          JSON.stringify({ id: 9_000_002, method: "Debugger.pause" }),
        );
        setTimeout(() => fail(new Error(`CDP ${method} 120 s 没有应答`)), 3000);
      }, 120_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails) {
      throw new Error(answer.exceptionDetails.text ?? "页面表达式抛错");
    }
    return answer.result.value;
  };
  const heapMb = async () => {
    const usage = await call("Runtime.getHeapUsage");
    return Math.round((usage.usedSize / 1024 / 1024) * 10) / 10;
  };
  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      join(output, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
  };

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  const console_ = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled") {
      if (message.params.type !== "error" && message.params.type !== "warning")
        return;
      console_.push(
        message.params.args
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(" ")
          .slice(0, 300),
      );
    }
    if (message.method === "Runtime.exceptionThrown") {
      console_.push(
        `EX ${message.params.exceptionDetails.text}: ${
          message.params.exceptionDetails.exception?.description ?? ""
        }`.slice(0, 300),
      );
    }
  });
  report.console = console_;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== "Debugger.paused") return;
    report.hungStack = message.params.callFrames
      .slice(0, 12)
      .map(
        (f) =>
          `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.location.lineNumber}`,
      );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Tracing.dataCollected") {
      traceEvents.push(...message.params.value);
    }
  });
  // 离开页面的确认框（未保存的改动）：不接住，导航会永远挂着。记下来，报告里能看到。
  report.dialogs = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== "Page.javascriptDialogOpening") return;
    report.dialogs.push(`${message.params.type}: ${message.params.message}`);
    void call("Page.handleJavaScriptDialog", { accept: true });
  });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  // 取证把手（`armadra.diag` 才暴露 `__armadraCanvasStore`，量墨迹条数用）。
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("armadra.diag", "1"); } catch {}`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: page });

  for (let attempt = 0; attempt < 240; attempt += 1) {
    const ready = await evaluate(
      `return document.querySelectorAll(${JSON.stringify(dom.node)}).length;`,
    );
    if (ready >= terminalCount) break;
    await sleep(500);
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const splash = await evaluate(
      `return document.getElementById("splash-root") ? 1 : 0;`,
    );
    if (!splash) break;
    await sleep(250);
  }
  if (!(await evaluate(`return window.__armadraProbe ? 1 : 0;`))) {
    throw new Error("仪器未注入：DevTools hook 垫片没跑");
  }

  /* --------------------------- 等 30 个真实会话 --------------------------- */

  // `alive` 是「这个 Runtime 实例里 PTY 还在跑」（`sessionSummarySchema`）；
  // `state` 是 agent 状态，没有 agent 的终端一直是 undefined，不能拿来数。
  report.mounted = await evaluate(`
    return {
      flowNodes: document.querySelectorAll(${JSON.stringify(dom.node)}).length,
      terminals: document.querySelectorAll('[data-slot="terminal-surface"]').length,
      xterm: document.querySelectorAll(".xterm").length,
      shells: document.querySelectorAll('[data-slot="node-shell"]').length,
      body: document.body.innerText.slice(0, 400),
    };
  `);
  await capture("mounted");
  step(
    "挂载情况",
    `${report.mounted.flowNodes} 个 RF 节点 / ${report.mounted.xterm} 个 xterm`,
  );

  let live = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const sessions = await api(`/api/workspaces/${created.id}/sessions`);
    live = sessions.filter((session) => session.alive).length;
    if (live >= terminalCount) break;
    await sleep(1000);
  }
  report.liveSessions = live;
  if (live < terminalCount) {
    throw new Error(`只有 ${live}/${terminalCount} 个会话在跑`);
  }
  step("真实会话已建立", `${live} 个 PTY 活着`);
  await sleep(3000);
  await capture("canvas");
  step("画布已渲染");

  /* -------------------------------- 输入基元 ------------------------------ */

  const mouse = (type, x, y, extra = {}) =>
    call("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      pointerType: "mouse",
      ...extra,
    });
  const click = async (x, y) => {
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y, { buttons: 0 });
  };
  const boxOf = (selector) =>
    evaluate(`
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);

  /**
   * 可选的计数器：`globalThis.__armadraCounters` 存在时一并记下来。
   *
   * 源码里**不留**这两个桩——`projectNodes` 的调用次数与 `commit()` 的次数是
   * 诊断量，不是产品行为。要复核 P2 那条「投影次数与节点数解耦」的结论时，
   * 在 `canvas/sync/project.ts` 的 `projectNodes` 与 `store/canvas/internal.ts`
   * 的 `commit()` 开头各加三行自增，跑完这个脚本再删掉；没打桩的构建上这里
   * 返回 null，脚本照跑。
   */
  const counters = () =>
    evaluate(`
      const c = globalThis.__armadraCounters;
      return c ? JSON.parse(JSON.stringify(c)) : null;
    `);
  const resetCounters = () =>
    evaluate(`
      const c = globalThis.__armadraCounters;
      if (c) { c.projectNodes = 0; c.projectedNodes = 0; c.commit = 0; c.commitLabels = {}; }
      return 1;
    `);

  // 诊断：`CANVAS_BENCH_EVAL=<js>` 在测量开始前在页面里跑一段脚本（试一个假设，不进基准）。
  if (process.env.CANVAS_BENCH_EVAL) {
    await evaluate(process.env.CANVAS_BENCH_EVAL);
    await sleep(1000);
  }

  /** 一段测量：开仪器 → 跑动作 → 停仪器 → 记堆、主线程耗时与 DOM 节点数。 */
  await call("Performance.enable");
  const perf = async () =>
    metricsMap((await call("Performance.getMetrics")).metrics);
  const measure = async (name, action) => {
    await sleep(800);
    await resetCounters();
    const before = await perf();
    const wall = Date.now();
    // 诊断：`CANVAS_BENCH_PROFILE=pan,drag` 对这些段录一份 CPU profile（不进基准数字，
    // 只用来找热点；录制本身有开销，别拿带 profile 的运行当基准）。
    const profiled = profileSegments.includes(name);
    if (profiled) {
      await call("Profiler.enable");
      await call("Profiler.setSamplingInterval", { interval: 500 });
      await call("Profiler.start");
    }
    // 诊断：`CANVAS_BENCH_TRACE=select` 录 Chrome 时间线（布局与样式重算的原因与元素数）。
    const traced = traceSegments.includes(name);
    if (traced) {
      traceEvents.length = 0;
      await call("Tracing.start", {
        traceConfig: {
          includedCategories: process.env.CANVAS_BENCH_TRACE_CATS
            ? process.env.CANVAS_BENCH_TRACE_CATS.split(",")
            : [
                "devtools.timeline",
                "disabled-by-default-devtools.timeline.invalidationTracking",
              ],
        },
        transferMode: "ReportEvents",
      });
    }
    const reactProfiled = reactSegments.includes(name);
    if (reactProfiled)
      await evaluate(`window.__armadraProbe.startProfiler(); return 1;`);
    await evaluate(
      `window.__armadraProbe.startFrames(${JSON.stringify(dom.stage)}); return 1;`,
    );
    await action();
    const raw = await evaluate(`return window.__armadraProbe.stopFrames();`);
    if (traced) {
      const done = new Promise((resolve) => {
        const onMessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.method === "Tracing.tracingComplete") {
            socket.removeEventListener("message", onMessage);
            resolve();
          }
        };
        socket.addEventListener("message", onMessage);
      });
      await call("Tracing.end");
      await done;
      writeFileSync(
        join(output, `trace-${name}.json`),
        JSON.stringify(traceEvents),
      );
    }
    if (reactProfiled) {
      const react = await evaluate(
        `return window.__armadraProbe.stopProfiler();`,
      );
      writeFileSync(
        join(output, `react-${name}.json`),
        JSON.stringify(react, null, 1),
      );
    }
    if (profiled) {
      const { profile } = await call("Profiler.stop");
      writeFileSync(
        join(output, `profile-${name}.cpuprofile`),
        JSON.stringify(profile),
      );
    }
    const elapsed = Date.now() - wall;
    const after = await perf();
    const frames = summarizeFrames(raw.times);
    if (!frames) throw new Error(`段 ${name} 没有采到帧`);
    const counted = await counters();
    report.segments[name] = {
      viewport: await evaluate(
        `return document.querySelector(${JSON.stringify(dom.viewport)})?.style.transform ?? null;`,
      ),
      ...frames,
      ...summarizeLatency(raw.latencies),
      longTasks: raw.longTasks,
      ...diffPerformance(before, after),
      wallMs: elapsed,
      heapMb: await heapMb(),
      ...(counted
        ? {
            projectNodes: counted.projectNodes,
            projectedNodes: counted.projectedNodes,
            storeCommits: counted.commit,
          }
        : {}),
    };
    step(
      `段：${name}`,
      `${frames.fps} fps，输入延迟 p50 ${report.segments[name].latencyMs ?? "—"} ms，p95 ${frames.p95Ms} ms，最慢 ${frames.slowestMs} ms，主线程 ${report.segments[name].mainThreadMs} ms，长任务 ${raw.longTasks}`,
    );
  };

  /* ---------------------------------- 空闲 -------------------------------- */

  await measure("idle", () => sleep(3000));

  /* ---------------------------------- 平移 -------------------------------- */

  const hand = await boxOf(
    'button[aria-label="手形"], button[aria-label="Hand"]',
  );
  if (!hand) throw new Error("Dock 里找不到手形工具");
  await click(hand.x, hand.y);
  await sleep(500);

  await measure("pan", async () => {
    // 画布空白处按下，固定 900 步画圆——真实的连续平移，不是一步到位；
    // 固定步数让两个引擎吃到同一串输入（不封顶时按时长算步数会不可比）。
    const centre = { x: 720, y: 460 };
    await mouse("mousePressed", centre.x, centre.y);
    let angle = 0;
    for (let i = 0; i < PAN_STEPS; i += 1) {
      angle += 0.12;
      await mouse(
        "mouseMoved",
        centre.x + Math.cos(angle) * 180,
        centre.y + Math.sin(angle) * 110,
      );
      await sleep(8);
    }
    // 回到按下那一点再松手：净平移为零，后面几段还能按原坐标找节点。
    await mouse("mouseMoved", centre.x, centre.y);
    await mouse("mouseReleased", centre.x, centre.y, { buttons: 0 });
    await sleep(300);
  });

  const select = await boxOf(
    'button[aria-label="选择"], button[aria-label="Select"]',
  );
  if (select) await click(select.x, select.y);
  await sleep(500);

  /* ------------------------------- 拖一个节点 ------------------------------ */

  // 拖拽把手是节点头部（`nodes/registry.ts` 的 `DRAG_HANDLE_CLASS`），不是整块
  // 节点体——按在终端正文上按到的是 xterm。
  const nodeAt = () =>
    evaluate(`
      // 挑离画布中心最近的那个终端：平移之后固定名字的那一个可能已经被
      // 侧边栏盖住或者移出视口，按下去什么都不会发生。
      const centre = { x: 820, y: 430 };
      let best = null;
      for (const element of document.querySelectorAll(${JSON.stringify(dom.node)})) {
        const head = element.querySelector(${JSON.stringify(dom.dragHandle)});
        if (!head) continue;
        const rect = head.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < 260 || x > 1380 || y < 20 || y > 820) continue;
        const distance = Math.hypot(x - centre.x, y - centre.y);
        if (!best || distance < best.distance) {
          const box = element.getBoundingClientRect();
          best = {
            distance,
            id: element.getAttribute(${JSON.stringify(dom.idAttr)}),
            x,
            y,
            nodeX: box.left,
            nodeY: box.top,
          };
        }
      }
      return best;
    `);
  const header = await nodeAt();
  if (!header) throw new Error("找不到 term-1 的拖拽把手");

  await measure("drag", async () => {
    await mouse("mousePressed", header.x, header.y);
    // 先走一小步越过 React Flow 的起拖阈值，再开始画圆。
    await mouse("mouseMoved", header.x + 6, header.y + 6);
    await sleep(40);
    let angle = 0;
    let last = { x: header.x + 6, y: header.y + 6 };
    for (let i = 0; i < DRAG_STEPS; i += 1) {
      angle += 0.12;
      last = {
        x: header.x + Math.cos(angle) * 120,
        y: header.y + Math.sin(angle) * 80,
      };
      await mouse("mouseMoved", last.x, last.y);
      await sleep(8);
    }
    await mouse("mouseReleased", last.x, last.y, { buttons: 0 });
    await sleep(400);
  });
  const after = await evaluate(`
    const element = document.querySelector(${JSON.stringify(dom.node)} + '[' + ${JSON.stringify(dom.idAttr)} + '="' + ${JSON.stringify(header.id)} + '"]');
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { nodeX: box.left, nodeY: box.top };
  `);
  report.dragMoved =
    after && Math.abs(after.nodeX - header.nodeX) > 1
      ? Math.round(after.nodeX - header.nodeX)
      : 0;
  if (!report.dragMoved) {
    await capture("drag-failed");
    throw new Error("拖拽那一段节点没动：测到的不是拖拽，是静止画面");
  }

  /* --------------------------- ctrl+滚轮连续缩放 -------------------------- */

  const zoomOf = () =>
    evaluate(`
      const element = document.querySelector(${JSON.stringify(dom.viewport)});
      const match = element && /scale\\(([-0-9.e]+)\\)/.exec(element.style.transform);
      return match ? Number(match[1]) : null;
    `);
  const zoomBefore = await zoomOf();
  await measure("zoom", async () => {
    const at = { x: 720, y: 460 };
    // 先放大再缩小，同样的步数与力度，视口回到起点附近，后面的段还能找到节点。
    // d3-zoom 对 ctrl+滚轮每步乘 e^(-deltaY×0.01)：24 步 ±5 约 3.3 倍，不撞缩放上下限。
    for (const deltaY of [-5, 5]) {
      for (let i = 0; i < ZOOM_STEPS; i += 1) {
        await call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: 0,
          deltaY,
          modifiers: 2,
        });
        await sleep(12);
      }
    }
    await sleep(300);
  });
  const zoomAfter = await zoomOf();
  if (zoomBefore === null || Math.abs(zoomAfter - zoomBefore) > 0.05) {
    throw new Error(`缩放段没有回到起点：${zoomBefore} → ${zoomAfter}`);
  }
  // 中途缩放确实发生过：用一次探测滚动确认缩放响应了（否则测到的是静止画面）。
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 720,
    y: 460,
    deltaX: 0,
    deltaY: -60,
    modifiers: 2,
  });
  await sleep(400);
  const zoomProbe = await zoomOf();
  report.zoomResponds = zoomProbe > zoomAfter;
  if (!report.zoomResponds) {
    throw new Error("ctrl+滚轮没有缩放画布：测到的不是缩放，是静止画面");
  }
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 720,
    y: 460,
    deltaX: 0,
    deltaY: 60,
    modifiers: 2,
  });
  await sleep(400);

  /* ---------------------------------- 框选 -------------------------------- */

  const selectedCount = () =>
    evaluate(
      `return document.querySelectorAll(${JSON.stringify(dom.selected)}).length;`,
    );
  await measure("select", async () => {
    // 右下空白处按下（避开右下角的小地图，按在小地图上拖的是视口），向左上拖出
    // 一个大框，固定步数。
    const from = { x: 1330, y: 660 };
    const to = { x: 330, y: 110 };
    await mouse("mousePressed", from.x, from.y);
    for (let i = 1; i <= SELECT_STEPS; i += 1) {
      const t = i / SELECT_STEPS;
      const wobble = Math.sin(t * Math.PI * 4) * 0.08 + 1;
      await mouse(
        "mouseMoved",
        from.x + (to.x - from.x) * t * wobble,
        from.y + (to.y - from.y) * t * wobble,
      );
      await sleep(8);
    }
    await mouse("mouseReleased", to.x, to.y, { buttons: 0 });
    await sleep(300);
    // 松手之后再数：自研引擎的框选在松手时才提交选区（React Flow 是边拖边选）。
    report.selectedNodes = await selectedCount();
  });
  if (!report.selectedNodes || report.selectedNodes < 5) {
    await capture("select-failed");
    throw new Error(
      `框选段只选中 ${report.selectedNodes} 个节点：测到的不是框选`,
    );
  }
  // 取消选择：点画布空白处。
  await click(1330, 660);
  await sleep(300);

  /* ----------------------- 便签里连续输入 100 字符 ------------------------ */

  // 点的是便签正文那块（`data-slot="sticky-markdown"`，点了才切成 textarea），不是节点
  // 正中——正中可能落在底栏或者被平移、拖拽之后叠上来的终端上。
  const sticky = await evaluate(`
    const body = document.querySelector(${JSON.stringify(SELECTORS.stickyBody)});
    if (!body) return null;
    body.scrollIntoView({ block: "center", inline: "center" });
    const rect = body.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(rect.height / 2, 12);
    const top = document.elementFromPoint(x, y);
    return { x, y, covered: !body.contains(top) };
  `);
  if (!sticky) throw new Error("找不到便签节点");
  if (sticky.covered) {
    report.stickyCovered = true;
    await evaluate(
      `document.querySelector(${JSON.stringify(SELECTORS.stickyBody)}).click(); return 1;`,
    );
  } else {
    await click(sticky.x, sticky.y);
  }
  await sleep(600);
  // 真实点击偶尔落在刚取消选择的重绘间隙里没触发；兜底用 DOM click，React 的
  // onClick 照常进入编辑态（点击本身不在测量段内）。
  const editorOpen = () =>
    evaluate(
      `return document.querySelector(${JSON.stringify(SELECTORS.stickyInput)}) ? 1 : 0;`,
    );
  for (let attempt = 0; attempt < 3 && !(await editorOpen()); attempt += 1) {
    report.stickyRetries = (report.stickyRetries ?? 0) + 1;
    await evaluate(
      `document.querySelector(${JSON.stringify(SELECTORS.stickyBody)})?.click(); return 1;`,
    );
    await sleep(600);
  }
  // 选择器必须限在便签里：每个终端的 xterm 都有一个隐藏的 helper textarea，
  // 排在便签前面。不限的话字符打进的是第一个终端的 PTY（每一下还会续一次
  // 驱动租约、广播一帧 `terminal.lease`），量到的根本不是便签。
  await evaluate(
    `const area = document.querySelector(${JSON.stringify(SELECTORS.stickyInput)}); if (area) area.focus(); return 1;`,
  );
  if (
    !(await evaluate(
      `return document.querySelector(${JSON.stringify(SELECTORS.stickyInput)}) ? 1 : 0;`,
    ))
  ) {
    throw new Error("便签没有进入编辑态");
  }

  // 保存请求是「document 真的换过」的外部可观测量之一（自动保存看 `dirty`）。
  const saves = [];
  await call("Network.enable");
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== "Network.requestWillBeSent") return;
    const { url, method } = message.params.request;
    if (method === "PUT" && url.endsWith("/document")) saves.push(url);
  });

  const text = "abcdefghij".repeat(10);
  const savesBefore = saves.length;
  await evaluate(`window.__armadraProbe.startProfiler(); return 1;`);
  await measure("typing", async () => {
    for (const char of text) {
      // `insertText` 走浏览器自己的编辑管线，React 的 onChange 照常收到；
      // 合成 keyDown 在 headless 里会被输入法层吃掉（实测 0/100 落地）。
      await call("Input.insertText", { text: char });
      await sleep(25);
    }
    await sleep(500);
  });
  report.typingRerender = await evaluate(
    `return window.__armadraProbe.stopProfiler();`,
  );

  const typed = await evaluate(
    `const area = document.querySelector(${JSON.stringify(SELECTORS.stickyInput)}); return area ? area.value.length : -1;`,
  );
  report.typing = {
    chars: text.length,
    landed: typed,
    saves: saves.length - savesBefore,
    commits: report.typingRerender.commits,
  };
  if (typed !== text.length) {
    step("注意", `便签里只落了 ${typed}/${text.length} 个字符`);
  }
  // 失焦提交：整段输入应当只形成一条历史。
  await evaluate(
    `const area = document.querySelector(${JSON.stringify(SELECTORS.stickyInput)}); if (area) area.blur(); return 1;`,
  );
  await sleep(1500);
  step(
    "便签输入完成",
    `落 ${typed} 字，输入期间 ${report.typingRerender.commits} 次 React commit，保存 ${report.typing.saves} 次`,
  );

  /* -------------------- 一次会话状态跳动的重渲组件数 --------------------- */

  const sessions = await api(`/api/workspaces/${created.id}/sessions`);
  const victim = sessions.find((session) => session.alive);
  if (!victim) throw new Error("没有可用于制造状态跳动的会话");

  await sleep(1500);
  await resetCounters();
  await evaluate(`window.__armadraProbe.startProfiler(); return 1;`);
  // 真实的一次跳动：把一个会话连持久会话一起销毁（三级终止的 `session`，
  // 契约 §15.5）。前端的 `onStatus` 会 `patch()` 连接状态并
  // `updateNodeData(lastExitCode)`——正是 §7.2 那条链的入口。
  await api(`/api/terminals/${victim.sessionId}/terminate`, {
    method: "POST",
    body: JSON.stringify({ mode: "session" }),
  });
  await sleep(2500);
  report.rerender = await evaluate(
    `return window.__armadraProbe.stopProfiler();`,
  );
  report.rerenderCounters = await counters();
  step(
    "一次会话状态跳动",
    `${report.rerender.commits} 次 commit，${report.rerender.rendered} 个组件重渲`,
  );

  // 撤销栈最后数：数法是「一直点到按钮灰掉」，这会真的把改动撤回去，所以
  // 必须排在所有测量之后。栈里装的是这一整轮走过的本地编辑（每个终端一条
  // `sessionId` 写入 + 便签那一条）。
  report.undoDepth = await countUndo(evaluate);
  step("撤销栈", `深 ${report.undoDepth}`);

  /* ----------------------- 300 条墨迹白板板上平移 ------------------------ */

  // 另开一张板，白板数据直接写进 `whiteboard`（v2；新引擎 B5 之后在
  // canvas-bench-lib.mjs 换成 v3 生成器）。视口罩住 4000×3000 的墨迹范围。
  // 两个引擎在这个提交上都只认 v3 存储（序列化与渲染互相独立，见设计 §3.1），
  // 所以两边写同一份 v3 内容；v2 写进去两边都会当空板打开，数字就是作弊。
  const inkDoc = buildInkWhiteboardV3();
  const inkSnapshot = (await loadCodec()).encodeDoc(inkDoc);
  step("v3 墨迹白板已编码", `${inkSnapshot.length} 字节`);
  const inkBoard = await api(`/api/workspaces/${created.id}/boards`, {
    method: "POST",
    body: JSON.stringify({ name: "ink" }),
  });
  const inkCurrent = await api(
    `/api/workspaces/${created.id}/boards/${inkBoard.id}/document`,
  );
  const inkSticky = seedNodes(inkBoard.id, 0);
  await api(`/api/workspaces/${created.id}/boards/${inkBoard.id}/document`, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: inkCurrent.board.updatedAt,
      nodes: inkSticky,
      edges: [],
      viewport: { x: 300, y: 60, zoom: 0.3 },
      whiteboard: inkSnapshot,
    }),
  });
  step("墨迹板已写入");
  const inkStored = await api(
    `/api/workspaces/${created.id}/boards/${inkBoard.id}/document`,
  );
  report.inkBoard = {
    items: inkDoc.items.length,
    pointsPerItem: inkDoc.items[0].points.length,
    whiteboardBytes: Buffer.byteLength(
      inkStored.board.whiteboard ?? "",
      "utf8",
    ),
  };
  if (report.inkBoard.whiteboardBytes === 0) {
    throw new Error("墨迹白板没有存进文档");
  }
  await call("Page.navigate", {
    url: `http://127.0.0.1:${port}/?workspace=${created.id}&board=${inkBoard.id}`,
  });
  await sleep(1500);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const ready = await evaluate(
      `return document.querySelectorAll(${JSON.stringify(dom.node)}).length;`,
    );
    const splash = await evaluate(
      `return document.getElementById("splash-root") ? 1 : 0;`,
    );
    if (ready >= 1 && !splash) break;
    await sleep(500);
  }
  await sleep(2000);
  await capture("ink");
  // 页面真的把 300 条墨迹读进来了：空板（v2 / 版本不符）跑出来的数字是虚高，直接判失败。
  report.inkBoard.loaded = await evaluate(`
    const items = globalThis.__armadraCanvasStore?.getState().whiteboard.items;
    return items ? items.filter((item) => item.kind === "ink").length : -1;
  `);
  if (report.inkBoard.loaded !== inkDoc.items.length) {
    await capture("ink-failed");
    throw new Error(
      `墨迹板页面里只有 ${report.inkBoard.loaded}/${inkDoc.items.length} 条墨迹：测到的是空板`,
    );
  }
  const inkHand = await boxOf(
    'button[aria-label="手形"], button[aria-label="Hand"]',
  );
  if (!inkHand) throw new Error("墨迹板里找不到手形工具");
  await click(inkHand.x, inkHand.y);
  await sleep(500);
  await measure("inkPan", async () => {
    const centre = { x: 720, y: 460 };
    await mouse("mousePressed", centre.x, centre.y);
    let angle = 0;
    for (let i = 0; i < PAN_STEPS; i += 1) {
      angle += 0.12;
      await mouse(
        "mouseMoved",
        centre.x + Math.cos(angle) * 180,
        centre.y + Math.sin(angle) * 110,
      );
      await sleep(8);
    }
    await mouse("mouseMoved", centre.x, centre.y);
    await mouse("mouseReleased", centre.x, centre.y, { buttons: 0 });
    await sleep(300);
  });
  step(
    "墨迹白板",
    `${report.inkBoard.items} 条（页面读入 ${report.inkBoard.loaded}），${report.inkBoard.whiteboardBytes} 字节`,
  );

  report.saves = saves.length;
  report.status = "ok";
}

/**
 * 白板 v3 编解码：probe 是纯 .mjs，不能直接 import TS 源码，经 esbuild 现场打一份。
 * 与应用里 `serializeWhiteboard` 是同一个 `codec.encodeDoc`。
 */
async function loadCodec() {
  const require = createRequire(join(root, "apps/server/package.json"));
  const built = await require("esbuild").build({
    entryPoints: [join(root, "packages/board/src/core/codec/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
  });
  const source = built.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
}

/** 撤销栈深度：Dock 的撤销按钮点几次才灰掉（上限 120，防死循环）。 */
async function countUndo(evaluate) {
  let depth = 0;
  for (; depth < 120; depth += 1) {
    const clicked = await evaluate(`
      const button = document.querySelector('button[aria-label="撤销"], button[aria-label="Undo"]');
      if (!button || button.disabled) return 0;
      button.click();
      return 1;
    `);
    if (!clicked) break;
    await sleep(120);
  }
  return depth;
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${report.error}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {
      // 清理尽力而为：对象可能已经退出或不在了
    }
  }
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
