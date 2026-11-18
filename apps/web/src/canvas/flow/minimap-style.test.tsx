import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentGlow } from "@/agent/display";

import { installDomPolyfills } from "@/app/test-harness";
import { toItemId } from "@/canvas/whiteboard/model";
import { TooltipProvider } from "@/ui/tooltip";
import {
  MINIMAP_COLORS,
  MinimapToggleButton,
  minimapFill,
  minimapItemOf,
  minimapStroke,
  minimapStrokeWidth,
} from "./minimap-style";

/** 状态缩略图的配色与收起钮。 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

function flowNode(
  id: string,
  type: "armadra" | "group" | "wb.text",
  selected = false,
) {
  return { id, type, selected } as const;
}

const noGlow = () => undefined;
const glowOf = (glow: AgentGlow) => () => glow;

describe("状态描边", () => {
  it("三种光晕各自映射到自己的 token", () => {
    expect(minimapStroke({ glow: "working" })).toBe(MINIMAP_COLORS.working);
    expect(minimapStroke({ glow: "attention" })).toBe(MINIMAP_COLORS.attention);
    // S3：出错和胶囊、圆点同一个红，不再画成品牌色。
    expect(minimapStroke({ glow: "failed" })).toBe(MINIMAP_COLORS.failed);
    expect(MINIMAP_COLORS.failed).not.toBe(MINIMAP_COLORS.unread);
    expect(minimapStrokeWidth(MINIMAP_COLORS.failed)).toBe(4);
    expect(minimapStroke({ glow: "unread" })).toBe(MINIMAP_COLORS.unread);
  });

  it("没有状态的节点、分组与白板对象一律中性描边", () => {
    expect(minimapStroke({})).toBe(MINIMAP_COLORS.plain);
    expect(minimapStroke({ plain: true, glow: "working" })).toBe(
      MINIMAP_COLORS.plain,
    );
  });

  it("有状态的画粗一点：缩略图上 1px 的色差不够", () => {
    expect(minimapStrokeWidth(MINIMAP_COLORS.working)).toBe(4);
    expect(minimapStrokeWidth(MINIMAP_COLORS.plain)).toBe(2);
  });

  it("填充按家族色混透明，浓度取主题令牌：常态 / 选中 / 分组与白板对象（#577）", () => {
    expect(minimapFill({ color: "var(--node-color-2)" })).toBe(
      "color-mix(in srgb, var(--node-color-2) var(--mm-fill), transparent)",
    );
    expect(minimapFill({ color: "var(--node-color-2)", selected: true })).toBe(
      "color-mix(in srgb, var(--node-color-2) var(--mm-fill-selected), transparent)",
    );
    expect(minimapFill({ plain: true })).toBe(
      "color-mix(in srgb, var(--faint) var(--mm-fill-plain), transparent)",
    );
  });

  it("无状态节点与白板对象用弱前景色 --faint，不用偏深的 --muted-foreground", () => {
    expect(MINIMAP_COLORS.plain).toBe("var(--faint)");
    expect(minimapStroke({})).toBe("var(--faint)");
    expect(minimapFill({ selected: true })).toBe(
      "color-mix(in srgb, var(--faint) var(--mm-fill-selected), transparent)",
    );
  });

  it("派发簇成员无状态时描边用簇色，有状态时仍是状态色", () => {
    const member = { cluster: true, color: "var(--node-color-3)" };
    expect(minimapStroke(member)).toBe("var(--node-color-3)");
    expect(minimapStroke({ ...member, glow: "working" })).toBe(
      MINIMAP_COLORS.working,
    );
    // 独立 Agent 与类型色只改填充，不改描边。
    expect(minimapStroke({ color: "var(--agent-codex)" })).toBe(
      MINIMAP_COLORS.plain,
    );
    expect(minimapStrokeWidth("var(--node-color-3)")).toBe(2);
  });
});

describe("节点 → 上色输入", () => {
  it("只有 `armadra` 节点参与状态描边", () => {
    expect(minimapItemOf(flowNode("n1", "armadra"), glowOf("working"))).toEqual(
      { plain: false, selected: false, glow: "working" },
    );
  });

  it("分组与白板对象一律 plain，不查状态表", () => {
    expect(minimapItemOf(flowNode("g1", "group"), glowOf("working"))).toEqual({
      plain: true,
      selected: false,
    });
    expect(
      minimapItemOf(flowNode(toItemId("i1"), "wb.text"), glowOf("working")),
    ).toEqual({ plain: true, selected: false });
  });

  it("家族色从 familyOf 的表里取，簇成员带 cluster", () => {
    const families = new Map([
      [
        "n1",
        {
          kind: "cluster" as const,
          rootId: "n1",
          color: "var(--node-color-1)",
        },
      ],
      ["n2", { kind: "agent" as const, color: "var(--agent-claude)" }],
      ["g1", { kind: "type" as const, color: "var(--mm-group)" }],
    ]);
    const member = minimapItemOf(flowNode("n1", "armadra"), noGlow, families);
    expect(member).toEqual({
      plain: false,
      selected: false,
      color: "var(--node-color-1)",
      cluster: true,
    });
    expect(minimapFill(member)).toBe(
      "color-mix(in srgb, var(--node-color-1) var(--mm-fill), transparent)",
    );
    expect(minimapItemOf(flowNode("n2", "armadra"), noGlow, families)).toEqual({
      plain: false,
      selected: false,
      color: "var(--agent-claude)",
    });
    expect(minimapItemOf(flowNode("g1", "group"), noGlow, families).color).toBe(
      "var(--mm-group)",
    );
  });

  it("选中态原样带过去", () => {
    expect(
      minimapItemOf(flowNode("n1", "armadra", true), noGlow).selected,
    ).toBe(true);
  });
});

describe("收起钮", () => {
  const renderToggle = (collapsed: boolean, onToggle = () => undefined) =>
    render(
      <TooltipProvider>
        <MinimapToggleButton collapsed={collapsed} onToggle={onToggle} />
      </TooltipProvider>,
    );

  it("展开时是一个「−」，点一下通知收起", () => {
    let toggled = 0;
    renderToggle(false, () => {
      toggled += 1;
    });
    const collapse = screen.getByRole("button", { name: "收起缩略图" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.querySelector(".lucide-minus")).toBeTruthy();
    fireEvent.click(collapse);
    expect(toggled).toBe(1);
  });

  it("收起后是缩略图图标，强边的 cluster 钮", () => {
    renderToggle(true);
    const expand = screen.getByRole("button", { name: "展开缩略图" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.querySelector(".lucide-map")).toBeTruthy();
    expect(expand.classList.contains("border-border-strong")).toBe(true);
  });

  it("不带原生 title：说明走 Tooltip", () => {
    renderToggle(false);
    expect(
      screen.getByRole("button", { name: "收起缩略图" }).hasAttribute("title"),
    ).toBe(false);
  });
});
