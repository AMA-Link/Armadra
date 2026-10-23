// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DURATION,
  EASE_DRAWER,
  EASE_IN_OUT,
  EASE_OUT,
  MOTION_SPRING,
  MOTION_TRANSITION,
} from "../ui/motion";

// vitest 默认把 CSS 模块 stub 成空串（`test.css: false`），连 `?raw` 也一样，
// 所以这里直接按文件读——本来要断言的也就是源文件的文本。
const tokensCss = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);
const appCss = readFileSync(
  fileURLToPath(new URL("./app.css", import.meta.url)),
  "utf8",
);
const motionCss = readFileSync(
  fileURLToPath(new URL("./motion.css", import.meta.url)),
  "utf8",
);
const settingsCss = readFileSync(
  fileURLToPath(new URL("./settings.css", import.meta.url)),
  "utf8",
);

/**
 * tokens.css 是 `src/ui/*` 与 Phase 1 全部界面 agent 的共享契约。
 * 这里不校验具体色值（那属于设计决定，会变），只校验“契约里的名字都在，
 * 并且深浅两套主题都各自声明了一遍”——这才是会被悄悄改坏的部分。
 */

/** docs/contracts/v3-agent-terminal-plan.md §4.3 里点名的 shadcn 别名。 */
const SHADCN_ALIASES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
] as const;

/** §3.1 的布局常量。 */
const LAYOUT_CONSTANTS: Record<string, string> = {
  "--tabbar-h": "44px",
  "--row-h": "28px",
  "--row-h-table": "36px",
  "--sidebar-w": "240px",
  "--dock-h": "44px",
  "--drawer-w": "360px",
  "--scm-w": "460px",
  "--settings-dialog-w": "min(calc(100vw - 96px), 1280px)",
  "--settings-dialog-h": "min(calc(100dvh - 96px), 860px)",
  "--settings-nav-w": "clamp(200px, 18%, 256px)",
  "--settings-topbar-h": "48px",
};

/** §3.1 的 z 轴栈，顺序不能乱。 */
const Z_SCALE: Array<[string, number]> = [
  ["--z-pills", 5],
  ["--z-canvas-overlay", 8],
  ["--z-sessions", 12],
  ["--z-dock", 20],
  ["--z-cluster", 26],
  ["--z-banners", 27],
  ["--z-shared-session", 28],
  ["--z-tabbar", 30],
  ["--z-focus", 40],
  ["--z-menu", 46],
  ["--z-dialog", 55],
  ["--z-focus-page", 60],
  ["--z-toast", 70],
  ["--z-splash", 90],
];

/** §3.4 的 Agent 品牌色。 */
const AGENT_COLORS: Record<string, string> = {
  "--agent-claude": "#d97757",
  "--agent-codex": "#10a37f",
  "--agent-opencode": "#a78bfa",
  "--agent-pi": "#e8b86d",
  "--agent-omp": "#d4a373",
  "--agent-copilot": "#a371f7",
  "--agent-ama": "#1cb5c9",
};

/** 设计系统 §2.4：每个内置 Agent 一个文字色，两套主题各自声明。 */
const AGENT_TEXT_COLORS = Object.keys(AGENT_COLORS).map(
  (name) => `${name}-text`,
);

/** 设计系统 §2.3–§2.10 新增、两套主题都要有的名字。 */
const THEMED_ADDITIONS = [
  "--on-agent",
  "--warn-text",
  "--success-text",
  "--working-text",
  "--caution-text",
  "--caution-soft",
  ...Array.from({ length: 8 }, (_, index) => `--member-${index + 1}`),
];

/** 设计系统 §2.6–§2.10 新增、与主题无关的常量。 */
const SCALE_ADDITIONS: Record<string, string> = {
  "--text-display": "22px",
  "--text-meta": "12px",
  "--text-code": "var(--text-meta)",
  "--text-input-touch": "16px",
  "--r-pill": "999px",
};

/** 设计系统 §2.10 / §8.2：动效令牌的定值。 */
const MOTION_TOKENS: Record<string, string> = {
  "--dur-instant": "100ms",
  "--dur-fast": "120ms",
  "--dur-base": "160ms",
  "--dur-slow": "200ms",
  "--dur-page": "280ms",
  "--dur-hero": "600ms",
  "--ease-out": "cubic-bezier(0.23, 1, 0.32, 1)",
  "--ease-in-out": "cubic-bezier(0.77, 0, 0.175, 1)",
  "--ease-drawer": "cubic-bezier(0.32, 0.72, 0, 1)",
  "--ease-color": "ease",
  "--press-scale": "0.97",
  "--pop-scale": "0.96",
  "--stagger": "40ms",
};

/** 设计系统 §2.8：七档语义圆角。 */
const RADII: Record<string, string> = {
  "--r-tight": "4px",
  "--r-control": "6px",
  "--r-card": "10px",
  "--r-panel": "12px",
  "--r-dialog": "14px",
  "--r-float": "16px",
  "--r-pill": "999px",
};

/** §3.4 的节点调色板 7 色。 */
const NODE_PALETTE = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
];

/**
 * 取出某个选择器后面第一层 `{...}` 的内容。用大括号计数而不是正则，
 * 因为 token 值里出现 `rgb(... / 10%)` 这类嵌套括号很常见。
 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`未找到选择器：${selector}`);
  // 从 `start` 而不是 `start + selector.length` 开始找，这样选择器串里
  // 带不带那个 `{` 都能正确定位。
  const open = css.indexOf("{", start);
  if (open === -1) throw new Error(`选择器缺少规则体：${selector}`);

  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const char = css[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`规则体没有闭合：${selector}`);
}

/** 把规则体解析成 `自定义属性名 → 值`。注释里的伪声明会被先剥掉。 */
function customProperties(body: string): Map<string, string> {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

const dark = customProperties(ruleBody(tokensCss, ":root {"));
const light = customProperties(
  ruleBody(tokensCss, ':root[data-theme="light"]'),
);

describe("tokens.css", () => {
  it("深色是默认主题（无属性选择器的 :root 就是深色）", () => {
    expect(dark.get("--tint-rgb")).toBe("255 255 255");
    expect(tokensCss).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*dark/);
  });

  it.each(SHADCN_ALIASES)("深色主题定义了 %s", (alias) => {
    expect(dark.has(alias)).toBe(true);
    expect(dark.get(alias)).toBeTruthy();
  });

  it.each(SHADCN_ALIASES)("浅色主题定义了 %s", (alias) => {
    expect(light.has(alias)).toBe(true);
    expect(light.get(alias)).toBeTruthy();
  });

  // 设计系统 §7 第 11 步：旧别名删除后不许再出现，也不许有人再引用它们。
  it.each(["--accent-text", "--accent-soft"])("旧别名 %s 已删除", (alias) => {
    expect(dark.has(alias)).toBe(false);
    expect(light.has(alias)).toBe(false);
    expect(tokensCss).not.toContain(`var(${alias})`);
  });

  it("没有悬空的 var() 引用", () => {
    const missing: string[] = [];
    for (const [theme, table] of [
      ["dark", dark],
      ["light", light],
    ] as const) {
      for (const [name, value] of table) {
        for (const match of value.matchAll(/var\((--[\w-]+)/g)) {
          const referenced = match[1]!;
          if (!dark.has(referenced))
            missing.push(`${theme} ${name} → ${referenced}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("shadcn 组件直接读的圆角变量都在 :root 上", () => {
    // button/badge 里有 `rounded-[min(var(--radius-md),10px)]` 这种写法，
    // `@theme inline` 不会把变量写进 :root，所以必须由 tokens.css 提供。
    for (const name of [
      "--radius",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--radius-2xl",
    ]) {
      expect(dark.has(name)).toBe(true);
    }
  });

  it("shadcn 圆角别名对齐语义档（sm=tight、md=control、lg=card、xl=panel、2xl=float）", () => {
    expect(dark.get("--radius-sm")).toBe("var(--r-tight)");
    expect(dark.get("--radius-md")).toBe("var(--r-control)");
    expect(dark.get("--radius-lg")).toBe("var(--r-card)");
    expect(dark.get("--radius-xl")).toBe("var(--r-panel)");
    expect(dark.get("--radius-2xl")).toBe("var(--r-float)");
    for (const [alias, token] of [
      ["sm", "tight"],
      ["md", "control"],
      ["lg", "card"],
      ["xl", "panel"],
      ["2xl", "float"],
    ]) {
      expect(appCss).toContain(`--radius-${alias}: var(--r-${token});`);
    }
    // 派生的 calc 档删掉了
    expect(appCss).not.toMatch(/--radius-[234]xl:\s*calc/);
  });

  it("品牌色与 shadcn 的 --accent 是两个不同的东西", () => {
    // shadcn 的 --accent 是菜单高亮底色；品牌蓝在 --brand / --primary
    expect(dark.get("--brand")).toBe("#0a84ff");
    expect(light.get("--brand")).toBe("#007aff");
    expect(dark.get("--primary")).toBe("var(--brand-solid)");
    expect(dark.get("--accent")).not.toContain("--brand");
  });

  it("表面高度阶梯完整", () => {
    for (const name of [
      "--surface-sunken",
      "--surface-deep",
      "--surface-base",
      "--surface-raised",
      "--surface-overlay",
    ]) {
      expect(dark.has(name)).toBe(true);
      expect(light.has(name)).toBe(true);
    }
  });

  it("布局常量按 §3.1 取值", () => {
    for (const [name, value] of Object.entries(LAYOUT_CONSTANTS)) {
      expect(dark.get(name)).toBe(value);
    }
  });

  it("z 轴栈取值与顺序都符合 §3.1", () => {
    const values = Z_SCALE.map(([name, expected]) => {
      expect(dark.get(name)).toBe(String(expected));
      return expected;
    });
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });

  it("Agent 品牌色深色保持各家原值，浅色换成压暗值（设计系统 §2.4）", () => {
    // 原先两套主题共用原值；白底上原值都不到 3:1，§2.4 改为浅色另给一组压暗值。
    for (const [name, value] of Object.entries(AGENT_COLORS)) {
      expect(dark.get(name)).toBe(value);
      expect(light.get(name)).toMatch(/^#[0-9a-f]{6}$/);
      expect(light.get(name)).not.toBe(value);
    }
  });

  it.each(AGENT_TEXT_COLORS)("Agent 文字色 %s 两套主题都有", (name) => {
    expect(dark.has(name)).toBe(true);
    expect(light.has(name)).toBe(true);
  });

  it.each(THEMED_ADDITIONS)("新增 token %s 两套主题都有", (name) => {
    expect(dark.has(name)).toBe(true);
    expect(light.has(name)).toBe(true);
  });

  it("新增的字号、动效、圆角常量按设计系统取值", () => {
    for (const [name, value] of Object.entries(SCALE_ADDITIONS)) {
      expect(dark.get(name)).toBe(value);
    }
  });

  it("深色成员色前七条就是节点调色板（§2.5）", () => {
    for (let n = 1; n <= 7; n += 1) {
      expect(dark.get(`--member-${n}`)).toBe(`var(--node-color-${n})`);
    }
  });

  it("小地图类型色两套主题都有，浅色与深色不同值（ui-wave2 §5.1）", () => {
    for (const type of [
      "sticky",
      "editor",
      "files",
      "browser",
      "diff",
      "automation",
    ]) {
      const name = `--mm-${type}`;
      expect(dark.get(name)).toMatch(/^#[0-9a-f]{6}$/);
      expect(light.get(name)).toMatch(/^#[0-9a-f]{6}$/);
      expect(light.get(name)).not.toBe(dark.get(name));
    }
    expect(dark.get("--mm-group")).toBe("transparent");
    expect(light.get("--mm-group")).toBe("transparent");
  });

  it("节点调色板是 §3.4 的 7 色", () => {
    const palette = Array.from({ length: 7 }, (_, index) =>
      dark.get(`--node-color-${index + 1}`),
    );
    expect(palette).toEqual(NODE_PALETTE);
  });

  it("状态色齐全", () => {
    for (const name of [
      "--danger",
      "--warn",
      "--caution",
      "--success",
      "--agent-working",
      "--status-working",
      "--status-attention",
      "--status-failed",
      "--status-queued",
      "--status-paused",
      "--status-unread",
      "--status-idle",
    ]) {
      expect(dark.has(name)).toBe(true);
    }
  });

  it("表面阶梯多了卡片这一档，且 --card 指向它", () => {
    // §24.2：窗口底 → 面板（+4%）→ 卡片（+7%），三档灰度替代线框分层
    for (const table of [dark, light]) {
      expect(table.has("--surface-card")).toBe(true);
      expect(table.get("--card")).toBe("var(--surface-card)");
    }
  });

  it("七档语义圆角齐全，Tailwind 工具类 rounded-* 都映射到位（§2.8）", () => {
    for (const [name, value] of Object.entries(RADII)) {
      expect(dark.get(name)).toBe(value);
      const tier = name.replace("--r-", "");
      expect(appCss).toContain(`--radius-${tier}: var(${name});`);
    }
  });

  it("旧名字 --r-md / --r-lg / --r-sm / --r-xl 与 --shadow-card / --shadow-pill 已全部删除", () => {
    for (const name of [
      "--r-md",
      "--r-lg",
      "--r-sm",
      "--r-xl",
      "--shadow-card",
      "--shadow-pill",
    ]) {
      expect(dark.has(name)).toBe(false);
      expect(light.has(name)).toBe(false);
    }
  });

  it("三档阴影：节点 / 浮层 / 对话框，浅色各自减半，卡片没有阴影", () => {
    for (const name of [
      "--shadow-node",
      "--shadow-overlay",
      "--shadow-dialog",
    ]) {
      expect(dark.get(name)).toMatch(/^0 /);
      expect(light.get(name)).toMatch(/^0 /);
      expect(light.get(name)).not.toBe(dark.get(name));
    }
    expect(dark.get("--shadow-overlay")).toBe("0 4px 12px rgb(0 0 0 / 28%)");
    expect(light.get("--shadow-overlay")).toBe("0 4px 12px rgb(0 0 0 / 8%)");
  });

  it("间距层级由内向外递增，区块间距拉得开（§2.7）", () => {
    const px = (name: string) =>
      Number((dark.get(name) ?? "").replace("px", ""));
    const item = px("--space-item");
    const group = px("--space-group");
    const inset = px("--space-inset");
    const block = px("--space-block");
    const section = px("--space-section");
    for (const value of [
      item,
      group,
      inset,
      block,
      section,
      px("--space-page"),
    ]) {
      expect(value % 4).toBe(0);
      expect(value).toBeGreaterThan(0);
    }
    expect(item).toBeLessThanOrEqual(group);
    expect(group).toBeLessThan(inset);
    expect(inset).toBeLessThanOrEqual(block);
    expect(block).toBeLessThan(section);
    expect(section).toBeGreaterThanOrEqual(2 * inset);
    expect(section).toBeGreaterThanOrEqual(1.5 * block);
  });

  it("字号阶梯是 22/17/15/13/12/11，没有 11px 以下的档位", () => {
    expect(dark.get("--text-display")).toBe("22px");
    expect(dark.get("--text-title")).toBe("17px");
    expect(dark.get("--text-section")).toBe("15px");
    expect(dark.get("--text-body")).toBe("13px");
    expect(dark.get("--text-meta")).toBe("12px");
    expect(dark.get("--text-caption")).toBe("11px");
  });

  it("app.css 的 @theme 把 Tailwind 刻度对齐阶梯：text-sm = 13、text-xs = 12，语义类与 tokens.css 同值", () => {
    const theme = customProperties(ruleBody(appCss, "@theme {"));
    expect(theme.get("--text-sm")).toBe("13px");
    expect(theme.get("--text-sm--line-height")).toBe("19px");
    expect(theme.get("--text-xs")).toBe("12px");
    expect(theme.get("--text-xs--line-height")).toBe("16px");
    // --text-base 不动：手机输入的 `text-base md:text-sm` 靠它保持 16
    expect(theme.has("--text-base")).toBe(false);
    for (const tier of [
      "display",
      "title",
      "section",
      "body",
      "meta",
      "caption",
    ]) {
      expect(theme.get(`--text-${tier}`), tier).toBe(
        dark.get(`--text-${tier}`),
      );
      expect(theme.get(`--text-${tier}--line-height`), tier).toMatch(/px$/);
    }
  });

  it("动效令牌按 §8.2 取定值（6 档时长、4 条曲线、按下 / 发芽缩放、错落）", () => {
    for (const [name, value] of Object.entries(MOTION_TOKENS)) {
      expect(dark.get(name), name).toBe(value);
    }
  });

  it("没有 ease-in 与回弹曲线；字面 cubic-bezier 只出现在 tokens.css", () => {
    const curves = [...tokensCss.matchAll(/cubic-bezier\(([^)]*)\)/g)].map(
      (match) => match[1]!.split(",").map(Number),
    );
    expect(curves.length).toBe(3);
    for (const [, y1, , y2] of curves) {
      // 回弹 = 控制点越界（y 小于 0 或大于 1）；ease-in 起手控制点 x1 > 0.4 且 y1 = 0
      expect(y1).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(1);
      expect(y2).toBeGreaterThanOrEqual(0);
      expect(y2).toBeLessThanOrEqual(1);
    }
    for (const value of [...dark.values(), ...light.values()])
      expect(value).not.toMatch(/\bease-in\b(?!-out)/);
    expect(motionCss).not.toContain("cubic-bezier(");
    expect(appCss).not.toContain("cubic-bezier(");
  });

  it("ui/motion.ts 的曲线与时长就是 tokens.css 的令牌（motion 库侧同值）", () => {
    const bezier = (name: string) =>
      /cubic-bezier\(([^)]*)\)/
        .exec(dark.get(name) ?? "")![1]!
        .split(",")
        .map(Number);
    expect([...EASE_OUT]).toEqual(bezier("--ease-out"));
    expect([...EASE_IN_OUT]).toEqual(bezier("--ease-in-out"));
    expect([...EASE_DRAWER]).toEqual(bezier("--ease-drawer"));
    for (const [key, ms] of Object.entries(DURATION)) {
      expect(`${Math.round(ms * 1000)}ms`, key).toBe(dark.get(`--dur-${key}`));
    }
    expect(MOTION_TRANSITION.duration).toBe(DURATION.base);
    expect(MOTION_SPRING).toEqual({ type: "spring", duration: 0.3, bounce: 0 });
  });

  it("状态色三件套：caution 也有 -text / -soft，--status-done 指向 --success", () => {
    expect(dark.get("--status-done")).toBe("var(--success)");
    expect(light.has("--caution-soft")).toBe(true);
    expect(dark.get("--caution-text")).toBe(dark.get("--caution"));
  });

  it("侧栏材质两套主题都声明了", () => {
    expect(dark.has("--sidebar-material")).toBe(true);
    expect(light.has("--sidebar-material")).toBe(true);
  });

  it("有 prefers-reduced-motion 保护：循环关掉，透明度与颜色过渡压到 --dur-fast", () => {
    expect(tokensCss).toContain("prefers-reduced-motion: reduce");
    expect(tokensCss).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(tokensCss).toMatch(
      /transition-duration:\s*var\(--dur-fast\)\s*!important/,
    );
    // Spinner 是唯一保留的循环；浮层与进场在减少动效下换成淡入
    expect(motionCss).toMatch(
      /\.anim-spin\s*\{[^}]*animation-iteration-count:\s*infinite\s*!important/,
    );
    expect(motionCss).toContain("animation-name: armadra-fade-in !important");
  });

  it("切换主题的一帧关掉全部过渡", () => {
    expect(tokensCss).toMatch(
      /\[data-theme-switching\] \*[\s\S]*?transition:\s*none\s*!important/,
    );
  });

  it("app.css 引入 motion.css 与 settings.css，设置规则不再留在 app.css", () => {
    expect(appCss).toContain('@import "./motion.css"');
    expect(appCss).toContain('@import "./settings.css"');
    expect(appCss).not.toContain(".settings-");
    expect(settingsCss).toContain(".settings-layout");
    expect(settingsCss).toContain('.settings-layout[data-narrow="true"]');
    expect(settingsCss).toContain(".settings-row-controls");
  });

  it("图标线宽 1.5 全局、会变的数字等宽、发丝线两端渐隐", () => {
    expect(appCss).toMatch(/\.lucide\s*\{\s*stroke-width:\s*1\.5px/);
    expect(appCss).toMatch(
      /\[data-numeric\][^{]*\{\s*font-variant-numeric:\s*tabular-nums/,
    );
    expect(appCss).toMatch(
      /\.hairline-x\s*\{[^}]*mask-image:\s*linear-gradient\(\s*90deg,\s*transparent/,
    );
  });

  it("浏览器 theme-color 与 --bg 同值", () => {
    const html = readFileSync(
      fileURLToPath(new URL("../../index.html", import.meta.url)),
      "utf8",
    );
    const colors = [
      ...html.matchAll(/name="theme-color"\s+content="(#[0-9a-f]{6})"/g),
    ].map((match) => match[1]);
    expect(colors.sort()).toEqual([dark.get("--bg"), light.get("--bg")].sort());
  });

  it("不加载在线字体", () => {
    expect(tokensCss).not.toMatch(/@font-face|fonts\.googleapis|https?:/);
  });
  /**
   * 几组会被悄悄改坏的对比度（WCAG 2.x 相对亮度公式）：实底按钮的白字、
   * 叠在自身浅底上的危险文字，以及按 50% 透明画的焦点环（1.4.11 要 3:1）。
   * 背景取两套主题里所有表面档位，按最差的那一档断言。
   */
  describe("对比度", () => {
    type Rgb = readonly [number, number, number];
    const hex = (value: string | undefined): Rgb => {
      const match = /^#([0-9a-f]{6})$/i.exec(value ?? "");
      if (!match?.[1]) throw new Error(`不是 6 位十六进制色：${value}`);
      const n = Number.parseInt(match[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const channel = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: Rgb) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const ratio = (a: Rgb, b: Rgb) => {
      const hi = Math.max(luminance(a), luminance(b));
      const lo = Math.min(luminance(a), luminance(b));
      return (hi + 0.05) / (lo + 0.05);
    };
    const over = ([r, g, b]: Rgb, alpha: number, [br, bg, bb]: Rgb): Rgb => [
      Math.round(r * alpha + br * (1 - alpha)),
      Math.round(g * alpha + bg * (1 - alpha)),
      Math.round(b * alpha + bb * (1 - alpha)),
    ];
    const surfaces = (theme: Map<string, string>) =>
      ["--bg", "--surface-card", "--surface-raised", "--surface-overlay"]
        .map((name) => theme.get(name) ?? dark.get(name))
        .filter((value): value is string => /^#/.test(value ?? ""))
        .map(hex);
    const white: Rgb = [255, 255, 255];

    it.each([
      ["深色", dark],
      ["浅色", light],
    ])("%s：实底按钮白字 ≥ 4.5，焦点环 50% ≥ 3", (_, theme) => {
      expect(
        ratio(white, hex(theme.get("--brand-solid"))),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        ratio(white, hex(theme.get("--danger-solid"))),
      ).toBeGreaterThanOrEqual(4.5);
      const ring = hex(theme.get("--focus-ring"));
      for (const bg of surfaces(theme)) {
        expect(ratio(over(ring, 0.5, bg), bg)).toBeGreaterThanOrEqual(3);
      }
    });

    it("深色：危险文字叠在自身 20% 的浅底上 ≥ 4.5（卡片与面板）", () => {
      const text = hex(dark.get("--danger-text"));
      for (const name of ["--surface-card", "--panel"]) {
        const bg = hex(dark.get(name));
        expect(ratio(text, over(text, 0.2, bg))).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});

/**
 * 安全区（设计系统 §3.1）：页面经 `viewport-fit=cover` 铺到屏幕边缘，贴边的浮层
 * 只认这几个变量。`env()` 带 `0px` 回退——桌面壳与普通浏览器里它们都是 0，
 * 布局与没有安全区时逐像素一致；窗口控件那两个缺省也是 0，只由手机壳原生层写。
 */
describe("安全区变量", () => {
  const indexHtml = readFileSync(
    fileURLToPath(new URL("../../index.html", import.meta.url)),
    "utf8",
  );

  it("viewport 铺到状态栏与刘海下面", () => {
    expect(indexHtml).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it.each(["top", "right", "bottom", "left"])(
    "--safe-%s 取 env() 且回退 0px",
    (side) => {
      expect(tokensCss).toContain(
        `--safe-${side}: env(safe-area-inset-${side}, 0px);`,
      );
    },
  );

  it("窗口控件占位缺省为 0", () => {
    expect(tokensCss).toContain("--window-controls-left: 0px;");
    expect(tokensCss).toContain("--window-controls-top: 0px;");
  });
});

/* -------------------- 上下文线的专用色（ui-wave2 §3.2） -------------------- */

function rgbOf(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hueOf(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((channel) => channel / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const raw =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return (raw * 60 + 360) % 360;
}

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** 派发簇用的节点色序号（`canvas/family.ts` 的 `CLUSTER_PALETTE`，family.test 守同一份）。 */
const CLUSTER_SLOTS = [1, 2, 3, 6, 7];

describe("--link-context", () => {
  it.each([
    ["深色", dark],
    ["浅色", light],
  ])("%s主题：是十六进制色，对画布底色 ≥ 3:1", (_name, theme) => {
    const color = theme.get("--link-context")!;
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(color, theme.get("--canvas-bg")!)).toBeGreaterThanOrEqual(
      3,
    );
  });

  it.each([
    ["深色", dark],
    ["浅色", light],
  ])("%s主题：色相与每一种簇色都隔开 ≥ 60°", (_name, theme) => {
    const hue = hueOf(theme.get("--link-context")!);
    for (const slot of CLUSTER_SLOTS) {
      const other = hueOf(dark.get(`--node-color-${slot}`)!);
      const gap = Math.min(Math.abs(hue - other), 360 - Math.abs(hue - other));
      expect(gap, `--node-color-${slot}`).toBeGreaterThanOrEqual(60);
    }
  });

  it("也和选中色（品牌蓝）分得开", () => {
    const gap = Math.abs(
      hueOf(dark.get("--link-context")!) - hueOf(dark.get("--brand")!),
    );
    expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(60);
  });
});
