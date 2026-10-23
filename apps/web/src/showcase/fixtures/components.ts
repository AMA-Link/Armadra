/**
 * `components` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用；这里的
 * 名字与正文是数据不是界面文案，允许中文（`i18n.test.ts` 排除了本目录）。
 */

export const BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "destructive-solid",
  "link",
] as const;

/** 控件高度五档（设计系统 §2.13）：24 / 28 / 32 / 36 / 44。 */
export const BUTTON_SIZES = ["xs", "sm", "default", "lg", "touch"] as const;

export const BADGE_VARIANTS = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "ghost",
  "link",
  "success",
  "warn",
  "brand",
] as const;

export const BADGE_SIZES = ["sm", "md"] as const;

/** 状态色的八个 tone（设计系统 §11.1）。 */
export const STATUS_TONES = [
  "working",
  "attention",
  "failed",
  "queued",
  "paused",
  "unread",
  "idle",
  "done",
] as const;

/** `StatusLine` 的阶段：细节是数据（命令、文件名），等宽显示。 */
export const STATUS_LINES = [
  { tone: "working", spinning: true, detail: "pnpm test", seconds: 12 },
  {
    tone: "attention",
    spinning: false,
    detail: "src/canvas/sync/project.ts",
    seconds: 95,
  },
  { tone: "failed", spinning: false, detail: "exit 1", seconds: 4 },
  { tone: "done", spinning: false, detail: "", seconds: 640 },
] as const;

/** 用量托盘（设计系统 §5.17）：值卡 / 阈值刻度 / 空值。 */
export const TRAY_CARDS = [
  { id: "claude", used: 82, delta: 15.2, window: "5h" },
  { id: "codex", used: 41, delta: -3, window: "5h" },
  { id: "copilot", used: Number.NaN, delta: null, window: "30d" },
  { id: "ama", used: 142, delta: null, window: "7d" },
] as const;

/** 边界值（设计系统 §12）：超长无空格串、两字名、emoji 首字。 */
export const EDGE_LABELS = [
  "ab",
  "🙂 表情开头的标签",
  "averyveryverylongunbrokenlabelthatmustnotbreakthelayoutatall.txt",
] as const;

export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
  "ama",
] as const;

export const MEMBERS = [
  { index: 1, name: "我" },
  { index: 2, name: "林夏" },
  { index: 3, name: "周屿" },
  { index: 4, name: "Mia" },
  { index: 5, name: "陈默" },
  { index: 6, name: "Noah" },
  { index: 7, name: "许诺" },
  { index: 8, name: "Ava" },
] as const;

export const SESSIONS = [
  {
    id: "s1",
    agent: "claude",
    title: "重构画布同步",
    time: "09:41",
    tone: "working",
  },
  {
    id: "s2",
    agent: "codex",
    title: "补齐迁移测试",
    time: "09:12",
    tone: "attention",
  },
  {
    id: "s3",
    agent: "ama",
    title: "拆分发布清单",
    time: "昨天",
    tone: "idle",
  },
] as const;

export const ACCORDION_ITEMS = [
  { id: "read", title: "Read src/canvas/sync/project.ts", body: "244 行" },
  { id: "edit", title: "Edit apps/web/vite.config.ts", body: "+3 −0" },
] as const;

export const SHORTCUT = ["⌘", "K"] as const;

/** `chart` 样本：一周的 token 用量（千），数值只是为了有高有低。 */
export const CHART_POINTS = [
  { day: "09-28", tokens: 42 },
  { day: "09-29", tokens: 18 },
  { day: "09-30", tokens: 64 },
  { day: "10-01", tokens: 37 },
  { day: "10-02", tokens: 81 },
  { day: "10-03", tokens: 55 },
  { day: "10-04", tokens: 29 },
] as const;
