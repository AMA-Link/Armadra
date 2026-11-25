import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokCardKey, parseGrokApprovalCard } from "./grok-card";

/**
 * 审批卡解析（契约 §127）。夹具全是 Grok Build 1.0.92 的真画面：脚本化模型 +
 * 隔离 `GROK_HOME` + tmux 截下来，本机路径换成 `/tmp/demo`，不含真实会话内容。
 */
function fixture(name: string): string {
  return readFileSync(
    join(__dirname, "__fixtures__/grok-card", `${name}.txt`),
    "utf8",
  );
}

describe("parseGrokApprovalCard", () => {
  it.each(["default-80", "default-120", "default-200"])(
    "命令卡 %s：允许一次 3、拒绝 4，不选 Always / Never",
    (name) => {
      const card = parseGrokApprovalCard(fixture(name));
      expect(card?.title).toBe("probe");
      expect(card?.allow).toEqual({ digit: "3", label: "Yes, proceed" });
      expect(card?.reject.digit).toBe("4");
      expect(card?.body).toContain('sh -c "echo x > out.txt"');
      expect(grokCardKey(card!, "allow")).toBe("3");
      expect(grokCardKey(card!, "deny")).toBe("4");
      expect(grokCardKey(card!, "other")).toBeUndefined();
    },
  );

  it("宽度不同，卡片哈希相同的内容只看正文：80 与 200 同卡", () => {
    expect(parseGrokApprovalCard(fixture("default-80"))?.hash).toBe(
      parseGrokApprovalCard(fixture("default-200"))?.hash,
    );
  });

  it("超长命令折行（┆ 续行）仍能认", () => {
    const card = parseGrokApprovalCard(fixture("longcmd-80"));
    expect(card?.allow.digit).toBe("3");
    expect(card?.body.length).toBeGreaterThan(2);
  });

  it("编辑卡：允许一次的标签是 Yes，编号 3，会话级放行（2）不选", () => {
    const card = parseGrokApprovalCard(fixture("write-120"));
    expect(card?.allow).toEqual({ digit: "3", label: "Yes" });
    expect(card?.reject.digit).toBe("4");
  });

  it("焦点移动不换卡：哈希不含 ●", () => {
    const base = fixture("default-120");
    const moved = base
      .replace("3 (●) Yes, proceed", "3 (○) Yes, proceed")
      .replace("1 (○) Always", "1 (●) Always");
    expect(parseGrokApprovalCard(moved)?.hash).toBe(
      parseGrokApprovalCard(base)?.hash,
    );
  });

  it("正文变了哈希就变", () => {
    const base = fixture("default-120");
    expect(
      parseGrokApprovalCard(base.replace("echo x", "echo y"))?.hash,
    ).not.toBe(parseGrokApprovalCard(base)?.hash);
  });

  it.each(["esc-120", "edit-120", "ask-120", "plan-120", "readout-120"])(
    "%s 不是可代答的审批卡",
    (name) => {
      expect(parseGrokApprovalCard(fixture(name))).toBeUndefined();
    },
  );

  it("页脚不是最后一个非空行就不认", () => {
    expect(
      parseGrokApprovalCard(
        `${fixture("default-120")}\n  some trailing line\n`,
      ),
    ).toBeUndefined();
  });

  it("选项行被打断、出现不认识的选项、重复标签都拒绝", () => {
    const base = fixture("default-120");
    expect(
      parseGrokApprovalCard(
        base.replace(
          "  ┃  4 (○) No, reject (type to add feedback)\n",
          "  ┃  4 (○) No, reject (type to add feedback)\n  ┃  note\n",
        ),
      ),
    ).toBeUndefined();
    expect(
      parseGrokApprovalCard(
        base.replace("Never allow: sh -c", "Allow for the whole server"),
      ),
    ).toBeUndefined();
    expect(
      parseGrokApprovalCard(
        base.replace("1 (○) Always allow", "3 (○) Always allow"),
      ),
    ).toBeUndefined();
    expect(
      parseGrokApprovalCard(
        base.replace(
          "4 (○) No, reject (type to add feedback)",
          "4 (○) Yes, proceed",
        ),
      ),
    ).toBeUndefined();
  });

  it("拒绝项整行相等才认：别的 No, reject… 写法不认", () => {
    const base = fixture("default-120");
    for (const label of [
      "No, reject",
      "No, reject (type to add feedback) and more",
      "No, reject everything",
    ]) {
      expect(
        parseGrokApprovalCard(
          base.replace("No, reject (type to add feedback)", label),
        ),
      ).toBeUndefined();
    }
  });

  it("没有编号的允许 / 拒绝、两个焦点都拒绝", () => {
    const base = fixture("default-120");
    expect(
      parseGrokApprovalCard(
        base.replace("3 (●) Yes, proceed", "  (●) Yes, proceed"),
      ),
    ).toBeUndefined();
    expect(
      parseGrokApprovalCard(base.replace("4 (○) No", "4 (●) No")),
    ).toBeUndefined();
  });

  it("性质：随机删行、改标签、跳号，选出的数字只可能落在允许一次或拒绝那一行", () => {
    const base = fixture("default-120").split("\n");
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    let parsed = 0;
    for (let round = 0; round < 600; round += 1) {
      const rows = [...base];
      const edits = 1 + (next() % 3);
      for (let k = 0; k < edits; k += 1) {
        const index = next() % rows.length;
        switch (next() % 4) {
          case 0:
            rows.splice(index, 1);
            break;
          case 1:
            rows[index] = (rows[index] ?? "").replace(
              /\d \(/,
              `${next() % 10} (`,
            );
            break;
          case 2:
            rows[index] = (rows[index] ?? "").replace(
              /(Yes|No|Always|Never)/,
              "Zed",
            );
            break;
          default:
            rows.splice(index, 0, rows[next() % rows.length] ?? "");
        }
      }
      const card = parseGrokApprovalCard(rows.join("\n"));
      if (card === undefined) continue;
      parsed += 1;
      for (const decision of ["allow", "deny"] as const) {
        const key = grokCardKey(card, decision);
        const line = card.options.find((option) => option.digit === key);
        expect(line).toBeDefined();
        expect(line?.label).toMatch(
          decision === "allow" ? /^Yes(, proceed)?$/ : /^No, reject\b/,
        );
        expect(line?.label).not.toMatch(
          /Always|Never|don't ask again|allow edits/,
        );
      }
    }
    expect(parsed).toBeGreaterThan(0);
  });
});
