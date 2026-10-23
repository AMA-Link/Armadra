// @vitest-environment node
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLASS_RULES,
  TYPE_RULES,
  UI_FORBIDDEN,
  baseOf,
  classBases,
  countHits,
  scanGuarded,
  uiSources,
} from "../lib/class-scan";
import { LEGACY_BUDGET } from "./class-guards.budget";

/**
 * 样式守卫（设计系统 §10）：功能代码（`ui/` 与示例数据之外的 `.ts` / `.tsx`）里不再写
 * 禁用的类名，只写语义类。每条规则的存量按文件登记在 `class-guards.budget.ts`：
 *
 *  - 个数**超过**登记 = 新增了违规，改成语义写法；
 *  - 个数**少于**登记 = 迁走了，把登记调小或删掉那一行（测试会提醒）。
 *
 * 各包迁完自己目录后把对应行删光，批次 3 全部归零。登记由
 * `UPDATE_CLASS_BUDGET=1 pnpm --filter @armadra/web exec vitest run src/styles/class-guards.test.ts`
 * 生成（再跑一遍 prettier）。字号规则（`TYPE_RULES`）一起登记，断言在 `type-scale.test.ts`。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const ALL_RULES = [...CLASS_RULES, ...TYPE_RULES];

let cache: ReturnType<typeof scanGuarded> | undefined;
const scanned = () => (cache ??= scanGuarded(SRC, ALL_RULES));

if (process.env.UPDATE_CLASS_BUDGET === "1") {
  describe("生成登记", () => {
    it("写 class-guards.budget.ts", () => {
      const budget: Record<string, Record<string, number>> = {};
      for (const rule of ALL_RULES) budget[rule.id] = {};
      for (const [file, counts] of [...scanned()].sort(([a], [b]) =>
        a.localeCompare(b),
      ))
        for (const [id, count] of Object.entries(counts))
          budget[id]![file] = count;
      writeFileSync(
        fileURLToPath(new URL("./class-guards.budget.ts", import.meta.url)),
        `/**
 * 样式守卫的存量登记：规则 id → 文件 → 现有个数（\`class-guards.test.ts\` 说明用法）。
 * 只减不增；各包迁完自己目录就删掉那一块，批次 3 归零。
 */
export const LEGACY_BUDGET: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = ${JSON.stringify(budget, null, 2)};
`,
      );
    });
  });
}

describe("扫描器", () => {
  it("baseOf 去掉变体前缀、重要性标记与负号，括号里的冒号不算", () => {
    expect(baseOf("md:hover:rounded-lg")).toBe("rounded-lg");
    expect(baseOf("data-[state=open]:rounded-sm!")).toBe("rounded-sm");
    expect(baseOf("[&_svg:not([class*='size-'])]:size-4")).toBe("size-4");
    expect(baseOf("-mt-1")).toBe("mt-1");
    expect(baseOf("!shadow-md")).toBe("shadow-md");
  });

  it("classBases 只看字符串字面量，注释与标识符不算", () => {
    const source = [
      "// rounded-lg 写在注释里",
      "const rounded = 3;",
      'const a = "rounded-md border";',
      'const b = `p-2 ${cond ? "x" : "y"} shadow-sm`;',
    ].join("\n");
    const bases = classBases(source);
    expect(bases).toContain("rounded-md");
    expect(bases).toContain("shadow-sm");
    expect(bases).not.toContain("rounded");
    expect(bases).not.toContain("rounded-lg");
  });

  it.each([
    ["rounded-bare", '"rounded border"', 1],
    ["rounded-bare", '"rounded-pill"', 0],
    ["rounded-scale", '"rounded-lg md:rounded-t-xl rounded-control"', 2],
    ["rounded-arbitrary", '"rounded-[var(--r-card)] rounded-tl-[2px]"', 2],
    [
      "shadow",
      '"shadow shadow-sm shadow-[0_1px_2px_#000] shadow-overlay shadow-none"',
      3,
    ],
    ["control-height", '"h-6 h-7 h-8 h-9 min-h-10 h-[28px]"', 4],
    [
      "var-class",
      '"text-[var(--warn)] bg-[var(--card)]/90 border-[var(--x)] text-[length:var(--text-body)]"',
      3,
    ],
    ["transition-all", '"transition-all duration-150"', 1],
    ["duration", '"duration-150 duration-(--dur-fast) duration-[120ms]"', 2],
    [
      "ease",
      '"ease-in ease-out ease-[cubic-bezier(0,0,1,1)] ease-(--ease-out)"',
      2,
    ],
    ["cubic-bezier", "const c = `cubic-bezier(0.1, 0, 0, 1)`;", 1],
    [
      "stroke-width",
      '<Icon strokeWidth={2} className="[&_svg]:[stroke-width:1.5]" />',
      2,
    ],
    ["sonner-import", 'import { toast } from "sonner";', 1],
    ["text-px", '"text-[13px] text-[0.8rem] text-body"', 2],
    ["text-length-var", '"text-[length:var(--text-body)]"', 1],
    [
      "text-scale",
      '"text-sm text-xs md:text-sm text-base text-body text-muted-foreground"',
      4,
    ],
  ] as const)("规则 %s 对 %s 命中 %i 处", (id, source, expected) => {
    expect(countHits(source, ALL_RULES)[id] ?? 0).toBe(expected);
  });
});

describe("功能代码里不再写禁用的类名", () => {
  it("真的扫到了功能代码，而不是空跑", () => {
    expect(scanned().size).toBeGreaterThan(50);
    expect([...scanned().keys()].some((file) => file.startsWith("ui/"))).toBe(
      false,
    );
  });

  it("每条规则都有登记块，没有悬空的规则 id", () => {
    expect(Object.keys(LEGACY_BUDGET).sort()).toEqual(
      ALL_RULES.map((rule) => rule.id).sort(),
    );
  });

  describe.each(ALL_RULES)("$id", (rule) => {
    const budget = () => LEGACY_BUDGET[rule.id] ?? {};

    it("个数不超过登记（新增的违规：" + "见 fix）", () => {
      const offenders = [...scanned()].flatMap(([file, counts]) => {
        const count = counts[rule.id] ?? 0;
        const allowed = budget()[file] ?? 0;
        return count > allowed
          ? [`${file}: ${count} 处（登记 ${allowed}）`]
          : [];
      });
      expect(offenders, rule.fix).toEqual([]);
    });

    it("登记不留过期项：迁走之后把个数调小或删掉那一行", () => {
      const stale = Object.entries(budget()).flatMap(([file, allowed]) => {
        const now = scanned().get(file)?.[rule.id] ?? 0;
        return now < allowed ? [`${file}: 登记 ${allowed}，现在 ${now}`] : [];
      });
      expect(stale).toEqual([]);
    });
  });
});

describe("ui/ 自己不带旧写法", () => {
  const files = uiSources(SRC);

  it("扫到了 ui/ 下的组件", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(UI_FORBIDDEN)("$id", (rule) => {
    const offenders = files.flatMap((path) => {
      const counts = countHits(readFileSync(path, "utf8"), [rule]);
      return counts[rule.id]
        ? [`${path.slice(SRC.length)} ×${counts[rule.id]}`]
        : [];
    });
    expect(offenders, rule.fix).toEqual([]);
  });
});
