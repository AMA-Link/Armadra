import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { blankComments } from "./scan-source";

/**
 * 样式守卫的扫描器（只给 `*.test.ts` 用，运行在 node 环境）：把源码里字符串字面量
 * 拆成 Tailwind 类名 token，去掉变体前缀后按规则表判断。规则表是设计系统 §10 的
 * 落地——功能代码只写语义类，禁止的写法按规则 id 分别计数，存量登记在
 * `styles/class-guards.budget.ts`，只减不增。
 */

/** 一条规则：`token` 在去掉变体前缀和重要性标记后的基名上判断；`code` 在整份源码上判断。 */
export interface ClassRule {
  readonly id: string;
  /** 违规时的修法，进测试失败信息。 */
  readonly fix: string;
  readonly token?: RegExp;
  readonly code?: RegExp;
}

/**
 * 去掉变体前缀：只认括号外的最后一个 `:`（任意变体 `[&_svg:not(...)]:x`、
 * `data-[state=open]:x` 的冒号在括号里或括号后）；再去掉 `!` 与负号。
 */
export function baseOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) cut = index;
  }
  return token
    .slice(cut + 1)
    .replace(/^!+|!+$/g, "")
    .replace(/^-/, "");
}

// 用字符串构造而不是正则字面量：`i18n.test.ts` 的朴素注释剥离器会被字面量里的引号带偏
const LITERAL = new RegExp("([\"'`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1", "g");

/** 源码（先抹掉注释）里所有字符串字面量里的空白分隔 token 的基名。 */
export function classBases(source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];
  for (const match of code.matchAll(LITERAL)) {
    const body = match[2] ?? "";
    // 模板字面量里的 `${…}` 先抹成空白，免得表达式里的字符串被当成类名拼接
    for (const token of body.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      if (token !== "") out.push(baseOf(token));
    }
  }
  return out;
}

export interface Hits {
  readonly counts: Readonly<Record<string, number>>;
}

/** 数一份源码里每条规则的命中个数（0 的不出现）。 */
export function countHits(
  source: string,
  rules: readonly ClassRule[],
): Record<string, number> {
  const bases = classBases(source);
  const code = blankComments(source);
  const counts: Record<string, number> = {};
  for (const rule of rules) {
    let count = 0;
    if (rule.token)
      for (const base of bases) if (rule.token.test(base)) count += 1;
    if (rule.code) count += [...code.matchAll(rule.code)].length;
    if (count > 0) counts[rule.id] = count;
  }
  return counts;
}

/* ------------------------------ 规则表（§10） ------------------------------ */

const CORNERS = "(?:-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?";

/** class-guards：圆角、阴影、高度、颜色变量、过渡、线宽、sonner。 */
export const CLASS_RULES: readonly ClassRule[] = [
  {
    id: "rounded-bare",
    fix: "bare `rounded`: use a semantic radius (rounded-tight / control / card / panel / dialog / float / pill)",
    token: /^rounded$/,
  },
  {
    id: "rounded-scale",
    fix: "rounded-sm/md/lg/xl/2xl: use the semantic radius tiers (tight / control / card / panel / float)",
    token: new RegExp(`^rounded${CORNERS}-(?:sm|md|lg|xl|2xl|3xl|4xl)$`),
  },
  {
    id: "rounded-arbitrary",
    fix: "rounded-[...] and rounded-[var(--r-*)]: use a semantic radius",
    token: new RegExp(`^rounded${CORNERS}-\\[`),
  },
  {
    id: "shadow",
    fix: "shadow / shadow-sm/md/lg / shadow-[...]: use shadow-node / shadow-overlay / shadow-dialog (cards have a 1px border, no shadow)",
    token: /^shadow(?:-(?:sm|md|lg|xl|2xl|xs|inner|\[.*))?$/,
  },
  {
    id: "control-height",
    fix: "hand-written h-6/7/9/10/11 and min-h-9/10: use the control size tiers (Button / Input / SelectTrigger size=xs|sm|default|lg|touch), and Item for list rows",
    token: /^(?:h|min-h)-(?:6|7|9|10|11)$/,
  },
  {
    id: "row-height",
    fix: "hand-written h-[28px] / h-[36px] / min-h-[28px] / min-h-[36px]: use the row-height tokens h-(--row-h) / h-(--row-h-table)",
    token: /^(?:min-)?h-\[(?:28|36)px\]$/,
  },
  {
    id: "var-class",
    fix: "text-[var(--x)] / bg-[var(--x)] / border-[var(--x)]: use the semantic class (text-danger-text, bg-card, border-border-strong ...)",
    token: /^(?:text|bg|border)-\[var\(--/,
  },
  {
    id: "transition-all",
    fix: "transition-all: name the properties (transition-[color,background-color,border-color] / transition-transform / transition-opacity)",
    token: /^transition-all$/,
  },
  {
    id: "duration",
    fix: "duration-N: use a token duration-(--dur-fast|base|slow|page) or a motion.css utility",
    token: /^duration-(?:\d+|\[.*\])$/,
  },
  {
    id: "ease",
    fix: "ease-in / ease-[...]: use ease-(--ease-out|in-out|drawer); ease-in is never used in the UI",
    token: /^ease-(?:in|\[.*\])$/,
  },
  {
    id: "cubic-bezier",
    fix: "literal cubic-bezier( belongs in tokens.css only; use the --ease-* tokens (the motion library takes the constants from ui/motion.ts)",
    code: /cubic-bezier\(/g,
  },
  {
    id: "stroke-width",
    fix: "strokeWidth / [stroke-width:...]: delete; `.lucide` sets 1.5 globally (write stroke-2 where 2 is wanted)",
    token: /^\[(?:&_svg\]:\[)?stroke-width:/,
    code: /\bstrokeWidth=/g,
  },
  {
    id: "sonner-import",
    fix: "import toast from `@/ui/toast`, never from sonner directly (only ui/toast.tsx and ui/sonner.tsx may)",
    code: /from\s+[\x22\x27]sonner[\x22\x27]/g,
  },
];

/** type-scale：功能代码只写语义字号类，字重不超过 semibold。 */
export const TYPE_RULES: readonly ClassRule[] = [
  {
    id: "text-px",
    fix: "text-[13px] and the like: use text-body / meta / caption / section / title / display",
    token: /^text-\[\d+(?:\.\d+)?(?:px|rem|em)\]$/,
  },
  {
    id: "text-length-var",
    fix: "text-[length:var(--text-*)]: use the semantic class of the same name (text-body ...)",
    token: /^text-\[length:/,
  },
  {
    id: "text-scale",
    fix: "text-sm/xs/base/lg...: use the semantic type classes; the phone input pair `text-base md:text-sm` lives in ui/ only",
    token: /^text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/,
  },
  {
    id: "font-heavy",
    fix: "font-bold / extrabold / black / font-[700]: the heaviest weight is font-semibold (--fw-semibold); titles use 590, never 700+",
    token: /^font-(?:bold|extrabold|black|\[(?:[7-9]00|bold|bolder)\])$/,
  },
];

/** `ui/` 自己不许再带的旧写法（生成件已按新令牌改过）。 */
export const UI_FORBIDDEN: readonly ClassRule[] = [
  {
    id: "transition-all",
    fix: "name the properties",
    token: /^transition-all$/,
  },
  {
    id: "tw-animate-overlay",
    fix: "overlay entrances use motion.css (motion-pop / motion-tip / motion-dialog / motion-overlay / motion-sheet)",
    token:
      /^(?:animate-in|animate-out|zoom-in-\d+|zoom-out-\d+|fade-in-\d+|fade-out-\d+|slide-in-from-[\w-]+|slide-out-to-[\w-]+)$/,
  },
  {
    id: "legacy-shadow",
    fix: "shadow-sm/md/lg and ring-foreground/10: use a 1px border or shadow-node / overlay / dialog",
    token: /^(?:shadow-(?:sm|md|lg|xs)|ring-foreground\/10)$/,
  },
  {
    id: "z-50",
    fix: "z-index goes through tokens z-(--z-menu) / z-(--z-dialog)",
    token: /^z-50$/,
  },
  {
    id: "legacy-radius",
    fix: "semantic radius",
    token: /^rounded-(?:2xl|3xl|4xl)$/,
  },
  {
    id: "font-heavy",
    fix: "font-semibold at most",
    token: /^font-(?:bold|extrabold|black|\[(?:[7-9]00|bold|bolder)\])$/,
  },
  { id: "duration", fix: "token duration", token: /^duration-(?:\d+|\[.*\])$/ },
  { id: "ease-in", fix: "no ease-in", token: /^ease-in$/ },
  { id: "cubic-bezier", fix: "token curve", code: /cubic-bezier\(/g },
  {
    id: "bare-cn",
    fix: "import cn from @/lib/cn",
    code: /from\s+[\x22\x27]cn[\x22\x27]/g,
  },
];

/* --------------------------------- 扫描 --------------------------------- */

/** 功能代码：`src/` 下的 `.ts` / `.tsx`，不含测试、顶层 `ui/`、示例数据、本扫描器与登记表。 */
export function guardedSources(root: string): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      const rel = relative(root, path).split(sep).join("/");
      if (statSync(path).isDirectory()) {
        if (rel === "ui" || rel === "showcase/fixtures") return [];
        return walk(path);
      }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
      if (
        rel === "lib/class-scan.ts" ||
        rel === "styles/class-guards.budget.ts"
      )
        return [];
      return [path];
    });
  return walk(root);
}

/** 每个文件、每条规则的命中个数：`file → { ruleId → count }`（0 命中的文件不出现）。 */
export function scanGuarded(
  root: string,
  rules: readonly ClassRule[],
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const path of guardedSources(root)) {
    const counts = countHits(readFileSync(path, "utf8"), rules);
    if (Object.keys(counts).length > 0)
      out.set(relative(root, path).split(sep).join("/"), counts);
  }
  return out;
}

/** 某条规则在某个文件里的命中个数。 */
export function hitsOf(
  scanned: Map<string, Record<string, number>>,
  file: string,
  ruleId: string,
): number {
  return scanned.get(file)?.[ruleId] ?? 0;
}

/** 扫 `ui/` 自己（顶层）：`ui/*.tsx` / `ui/*.ts`，不含测试。 */
export function uiSources(root: string): string[] {
  const directory = join(root, "ui");
  return readdirSync(directory)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(directory, name));
}
