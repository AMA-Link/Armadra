// 画布基准的纯函数部分：页面选择器、帧时汇总、CDP 指标差值、白板样本生成、
// 指标清单（含「越大越好 / 越小越好」方向）、中位数聚合与逐项比较。
//
// 不起进程、不开端口；测试在同目录的 canvas-bench.test.mjs（`pnpm release:test`）。
// `canvas-stress.mjs` 产出 result.json，`canvas-bench-compare.mjs` 比较两份。

export const SCHEMA = 2;

/**
 * 探针依赖的页面选择器。组件改名时 canvas-bench.test.mjs 会读源码断言这些
 * `data-slot` 仍在（#956：便签正文改成 `sticky-markdown` 后探针悄悄失效）。
 */
export const SELECTORS = {
  stickyNode: '[data-slot="sticky-node"]',
  stickyBody: '[data-slot="sticky-markdown"]',
  stickyInput: '[data-slot="sticky-node"] textarea',
};

/**
 * 两个画布引擎在页面里的 DOM 约定。探针只经这张表找节点、视口与选中态，
 * 两个引擎吃同一串输入、量同一类东西。`current` 是 React Flow，`next` 是自研引擎。
 */
export const ENGINES = {
  current: {
    node: ".react-flow__node",
    viewport: ".react-flow__viewport",
    selected: ".react-flow__node.selected",
    dragHandle: ".drag-handle",
    idAttr: "data-id",
    /** 输入延迟只认这块舞台里的变动（视口、节点、框选框）。 */
    stage: ".react-flow",
  },
  next: {
    node: '[data-board-layer="world"] > [data-board-id]',
    viewport: '[data-board-layer="world"]',
    selected:
      '[data-board-layer="world"] > [data-board-id] [data-slot="node-shell"][data-selected="true"]',
    dragHandle: ".drag-handle",
    idAttr: "data-board-id",
    stage: ":has(> [data-board-layer])",
  },
};

/** 每段（场景）记录的指标；顺序即表格顺序。 */
export const SEGMENTS = [
  "idle",
  "pan",
  "drag",
  "zoom",
  "select",
  "typing",
  "inkPan",
];

/**
 * 逐段指标的定义。`higher` 为 true 表示越大越好，否则越小越好。
 * `floor`：计数类指标，基线已是 0 时无法「严格更优」，持平记为通过（表里标 floor）。
 * `noise`：受 GC、帧心跳量化左右、两个引擎谁快会在轮与轮之间翻转的指标；候选
 * 中位数不超过基线 7 次里最差的一次即过（表里标「波动内」），见 `compareMetrics`。
 * `record`：只写进 result.json，不进比较。
 */
export const SEGMENT_METRICS = [
  // 平均帧率只记录不比较：不封顶后它数的是「每个输入出了几帧」。旧引擎在帧后
  // 提交、每个输入要补 2–3 帧，新引擎同一帧写完只出一帧——帧多是白画，不是更顺。
  // 判别改用输入到出帧的延迟（用户看到响应要等多久）。
  { key: "fps", label: "平均帧率 fps", higher: true, record: true },
  // p50 / p95 帧时写进 result.json 但不进比较：不封顶后帧时是双峰的（输入合并出的
  // 毫秒级帧 + 压在 17.7 ms 上的 60 Hz 心跳帧），p95 在旧引擎上就贴着 17.7 ms，
  // 新引擎再快也只能打平，没有判别力。
  // 延迟受 Chrome 把输入对齐到帧心跳左右（两边都在 10 ms 上下），亚毫秒差在轮与
  // 轮之间翻转，按 `noise` 判：不超过旧引擎 7 次里最差的一次。
  {
    key: "latencyMs",
    label: "输入到出帧延迟 p50 ms",
    higher: false,
    noise: true,
  },
  { key: "slowestMs", label: "最慢一帧 ms", higher: false, noise: true },
  {
    key: "over33",
    label: "超 33.4 ms 帧数",
    higher: false,
    floor: true,
    noise: true,
  },
  // 缩放段两边都有一次 Dock 布局的长任务；按 `noise` 判，持平即在波动内。
  {
    key: "longTasks",
    label: "长任务数 >50 ms",
    higher: false,
    floor: true,
    noise: true,
  },
  { key: "mainThreadMs", label: "主线程脚本+布局+样式 ms", higher: false },
  { key: "taskMs", label: "主线程任务总耗时 ms", higher: false },
  { key: "heapMb", label: "JS 堆 MB", higher: false, noise: true },
  { key: "domNodes", label: "DOM 节点数", higher: false },
];

/**
 * 输入节奏决定帧数的段：空闲没有任何变化，输入段被固定的 25 ms 打字间隔
 * 限住，帧率与帧时反映的是 Chrome 无损伤时的 60 Hz 心跳，不是引擎。这两段
 * 的帧指标照常写进 result.json，但不进比较，只比 CPU、长任务、堆与 DOM 节点。
 * 空闲段什么都不做，CPU 只是后台定时器的抖动，整段按 `noise` 判。
 */
export const PACED_SEGMENTS = ["idle", "typing"];
export const FRAME_KEYS = ["fps", "latencyMs", "slowestMs", "over33"];
export const NOISY_SEGMENTS = ["idle"];

/** 非逐段的指标。 */
export const GLOBAL_METRICS = [
  { key: "rerender.rendered", label: "会话状态跳动重渲组件数", higher: false },
  { key: "rerender.commits", label: "会话状态跳动 commit 数", higher: false },
  // `tie`：两边持平即过。打字每个字符一次 commit 已是下限；白板字节同一提交上
  // 两个引擎存的是同一份 v3 内容（旧格式 v2 是 581,414 字节，见基线报告）。
  {
    key: "typing.commits",
    label: "输入 100 字符 commit 数",
    higher: false,
    tie: true,
  },
  {
    key: "inkBoard.whiteboardBytes",
    label: "300 条墨迹白板字节数",
    higher: false,
    tie: true,
  },
];

export function metricList() {
  const list = [];
  for (const segment of SEGMENTS) {
    for (const metric of SEGMENT_METRICS) {
      if (PACED_SEGMENTS.includes(segment) && FRAME_KEYS.includes(metric.key))
        continue;
      list.push({
        ...metric,
        ...(NOISY_SEGMENTS.includes(segment) ? { noise: true } : {}),
        key: `${segment}.${metric.key}`,
        label: `${segment} ${metric.label}`,
      });
    }
  }
  return [...list, ...GLOBAL_METRICS];
}

const round = (value, places = 1) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** 页面 rAF 时间戳序列 → 帧统计。少于两个时间戳返回 null。 */
export function summarizeFrames(times) {
  if (!Array.isArray(times) || times.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < times.length; i += 1)
    deltas.push(times[i] - times[i - 1]);
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const span = times[times.length - 1] - times[0];
  return {
    seconds: round(span / 1000),
    frames: deltas.length,
    fps: span > 0 ? round((deltas.length * 1000) / span) : 0,
    p50Ms: round(at(0.5), 2),
    p95Ms: round(at(0.95), 2),
    slowestMs: round(sorted[sorted.length - 1], 2),
    over33: deltas.filter((delta) => delta > 33.4).length,
  };
}

/** 每个输入到出帧的延迟（ms）→ p50 / p95 / 样本数。没有样本返回空对象。 */
export function summarizeLatency(values) {
  if (!Array.isArray(values) || values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    latencyMs: round(at(0.5), 2),
    latencyP95Ms: round(at(0.95), 2),
    latencyInputs: sorted.length,
  };
}

/** CDP `Performance.getMetrics` 的 `metrics` 数组 → 名字到值的表。 */
export function metricsMap(metrics) {
  const map = {};
  for (const { name, value } of metrics ?? []) map[name] = value;
  return map;
}

/** 两次 `Performance.getMetrics` 的差值（累计量按秒算成毫秒，Nodes 取结束值）。 */
export function diffPerformance(before, after) {
  const ms = (name) =>
    round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000, 1);
  const script = ms("ScriptDuration");
  const layout = ms("LayoutDuration");
  const style = ms("RecalcStyleDuration");
  return {
    mainThreadMs: round(script + layout + style, 1),
    scriptMs: script,
    layoutMs: layout,
    styleMs: style,
    taskMs: ms("TaskDuration"),
    domNodes: after.Nodes ?? 0,
  };
}

/* ------------------------------- 白板样本 ------------------------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededId(rand) {
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join(
      "",
    );
  return `wb:${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/**
 * 墨迹配方（v2 / v3 生成器共用，保证两边内容逐点等价）：种子固定、完整 double
 * 精度、朝向随机游走、压力恒 0.5。返回与格式无关的对象列表。
 */
function inkRecipe(count, points, seed) {
  const rand = mulberry32(seed);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    let x = rand() * 40;
    let y = rand() * 40;
    let angle = rand() * Math.PI * 2;
    const pts = [[x, y, 0.5]];
    for (let p = 1; p < points; p += 1) {
      angle += (rand() - 0.5) * 0.6;
      const step = 1 + rand() * 3;
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
      pts.push([x, y, 0.5]);
    }
    const xs = pts.map((point) => point[0]);
    const ys = pts.map((point) => point[1]);
    items.push({
      id: seededId(rand),
      x: rand() * 4000,
      y: rand() * 3000,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      z: index,
      points: pts,
    });
  }
  return items;
}

/**
 * v2 白板文档（上一代格式，旧引擎基线用的就是它）：`count` 条各 `points` 点的墨迹。
 * 配方与基线报告「白板 v2 字节数」一节相同。
 */
export function buildInkWhiteboardV2(count = 300, points = 40, seed = 952) {
  const items = inkRecipe(count, points, seed).map((item) => ({
    ...item,
    kind: "ink",
    style: { color: "black", size: "m" },
  }));
  return { engine: "armadra-flow", version: 2, items, references: [] };
}

/**
 * v3 白板文档（`@armadra/board` 的 `BoardDoc`，内存形态，交给 `codec.encodeDoc` 序列化）：
 * 与 v2 生成器同一配方，每条墨迹的 id、位置、盒与逐个采样点都与 v2 相同，
 * 只是外壳与对象形状换成 v3。新引擎把 v2 白板当空板打开，所以候选必须写这个。
 */
export function buildInkWhiteboardV3(count = 300, points = 40, seed = 952) {
  const items = inkRecipe(count, points, seed).map((item) => ({
    ...item,
    kind: "ink",
    style: { color: "black", size: "m" },
  }));
  return { engine: "armadra-board", version: 3, items, references: [] };
}

/* --------------------------- 展平 / 聚合 / 比较 --------------------------- */

/** result.json → `{ 指标键: 数 }`。缺的段与缺的值直接缺席，比较时报「缺失」。 */
export function flatten(result) {
  const out = {};
  for (const segment of SEGMENTS) {
    const data = result?.segments?.[segment];
    if (!data) continue;
    for (const { key } of SEGMENT_METRICS) {
      if (typeof data[key] === "number") out[`${segment}.${key}`] = data[key];
    }
  }
  const pick = (key, value) => {
    if (typeof value === "number") out[key] = value;
  };
  pick("rerender.rendered", result?.rerender?.rendered);
  pick("rerender.commits", result?.rerender?.commits);
  pick("typing.commits", result?.typing?.commits);
  pick("inkBoard.whiteboardBytes", result?.inkBoard?.whiteboardBytes);
  return out;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 线性插值分位数。 */
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * 多次运行取逐项中位数，并给出每项的波动：`spread` 是四分位距 / 中位数
 * （对单次离群不敏感），`range` 是 (max-min) / 中位数。中位数为 0 时，
 * 全相同记 0，否则记 null。
 */
export function aggregate(results) {
  const flats = results.map(flatten);
  const metrics = {};
  const spread = {};
  const range = {};
  const bounds = {};
  for (const { key } of metricList()) {
    const values = flats
      .map((flat) => flat[key])
      .filter((v) => typeof v === "number");
    if (values.length === 0) continue;
    const mid = median(values);
    metrics[key] = round(mid, 2);
    const full = Math.max(...values) - Math.min(...values);
    const iqr = quantile(values, 0.75) - quantile(values, 0.25);
    const rel = (x) =>
      mid === 0 ? (x === 0 ? 0 : null) : round(x / Math.abs(mid), 3);
    spread[key] = rel(iqr);
    range[key] = rel(full);
    bounds[key] = [Math.min(...values), Math.max(...values)];
  }
  return { metrics, spread, range, bounds, runs: results.length };
}

/** 读 result.json 或基线文件，统一成指标表。 */
export function loadMetrics(json) {
  return json?.metrics && typeof json.metrics === "object"
    ? json.metrics
    : flatten(json);
}

/** 基线文件里每项 7 次运行的 [最小, 最大]；单次 result.json 没有就是空表。 */
export function loadBounds(json) {
  return json?.bounds && typeof json.bounds === "object" ? json.bounds : {};
}

/**
 * 逐项比较。严格更优才算过，以下例外：
 * - `floor` 指标基线为 0 时，候选也为 0 记「floor」（已在下限，无法更优）；
 * - `tie` 指标持平记「持平」算过；
 * - `noise` 指标候选不超过基线运行里最差的一次（`bounds`）记「波动内」算过。
 * `record` 指标不进比较。缺失任一侧一律判不过。
 */
export function compareMetrics(baseline, candidate, bounds = {}) {
  const rows = metricList()
    .filter((metric) => !metric.record)
    .map((metric) => {
      const base = baseline[metric.key];
      const next = candidate[metric.key];
      if (typeof base !== "number" || typeof next !== "number") {
        return { ...metric, base, next, status: "missing", pass: false };
      }
      const better = metric.higher ? next > base : next < base;
      if (better)
        return { ...metric, base, next, status: "better", pass: true };
      if (metric.floor && base === 0 && next === 0) {
        return { ...metric, base, next, status: "floor", pass: true };
      }
      if (metric.tie && next === base) {
        return { ...metric, base, next, status: "tie", pass: true };
      }
      const worst = bounds[metric.key]?.[metric.higher ? 0 : 1];
      if (
        metric.noise &&
        typeof worst === "number" &&
        (metric.higher ? next >= worst : next <= worst)
      ) {
        return { ...metric, base, next, status: "noise", pass: true };
      }
      return {
        ...metric,
        base,
        next,
        status: next === base ? "equal" : "worse",
        pass: false,
      };
    });
  return { rows, pass: rows.every((row) => row.pass) };
}

export function renderComparison({ rows }) {
  const fmt = (v) => (typeof v === "number" ? String(v) : "—");
  const ratio = (row) =>
    typeof row.base === "number" &&
    typeof row.next === "number" &&
    row.base !== 0
      ? `${(((row.next - row.base) / Math.abs(row.base)) * 100).toFixed(1)}%`
      : "";
  const mark = {
    better: "更优",
    floor: "floor",
    tie: "持平",
    noise: "波动内",
    equal: "持平",
    worse: "更差",
    missing: "缺失",
  };
  const lines = [
    ["指标", "方向", "基线", "候选", "变化", "结果"],
    ...rows.map((row) => [
      row.key,
      row.higher ? "越大越好" : "越小越好",
      fmt(row.base),
      fmt(row.next),
      ratio(row),
      row.pass ? mark[row.status] : `FAIL ${mark[row.status]}`,
    ]),
  ];
  const widths = lines[0].map((_, col) =>
    Math.max(...lines.map((line) => [...line[col]].length)),
  );
  return lines
    .map((line) =>
      line
        .map((cell, col) => cell + " ".repeat(widths[col] - [...cell].length))
        .join("  "),
    )
    .join("\n");
}
