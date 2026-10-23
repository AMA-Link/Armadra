import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Position, type ConnectionLineComponentProps } from "@xyflow/react";

import { CORNER_RADIUS, routeFor } from "./link-visual";
import { roundedPath } from "./route";
import { ConnectionLine } from "./ConnectionLine";

/**
 * 拖线时的预览（React Flow 计划 §2.5 第三条）。
 *
 * 替代旧引擎的 `shapes/NodeArrowShapeUtil.test.tsx`（那一项测的是箭头工具
 * 的预览覆写）。这里只有一条断言值得写：预览与落成后的 `LinkEdge`
 * **必须是同一条曲线**，否则松手那一刻线会突然弹到别处。
 */

afterEach(cleanup);

function internalNode(x: number, y: number) {
  return {
    id: `n-${x}`,
    measured: { width: 100, height: 100 },
    width: 100,
    height: 100,
    internals: { positionAbsolute: { x, y } },
  };
}

function renderLine(
  toNode: ReturnType<typeof internalNode> | null,
  status: "valid" | "invalid" | null = null,
) {
  const props = {
    fromNode: internalNode(0, 0),
    toNode,
    toX: 300,
    toY: 50,
    fromX: 100,
    fromY: 50,
    fromPosition: Position.Right,
    toPosition: Position.Left,
    connectionStatus: status,
  } as unknown as ConnectionLineComponentProps;
  return render(
    <svg>
      <ConnectionLine {...props} />
    </svg>,
  );
}

function path(container: HTMLElement): SVGPathElement {
  return container.querySelector(
    '[data-slot="connection-line"] path',
  ) as SVGPathElement;
}

describe("ConnectionLine", () => {
  it("落在目标上时画的就是 `LinkEdge` 那种线", () => {
    const { container } = renderLine(internalNode(300, 0));
    const expected = routeFor(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 300, y: 0, width: 100, height: 100 },
    );
    expect(path(container).getAttribute("d")).toBe(
      roundedPath(expected.points, CORNER_RADIUS),
    );
  });

  it("还没落到目标上时把指针当成零尺寸矩形，仍然贴边起笔", () => {
    const { container } = renderLine(null);
    const d = path(container).getAttribute("d") ?? "";
    // 起点是起笔节点右侧边的中点，不是节点中心也不是把手坐标。
    expect(d).toMatch(/^M 100,50 /u);
    expect(d).toMatch(/ 300,50$/u);
  });

  it("悬空时画虚线，落到目标上变实线", () => {
    const loose = renderLine(null);
    expect(path(loose.container).getAttribute("stroke-dasharray")).toBe("6 4");
    cleanup();

    const landed = renderLine(internalNode(300, 0));
    expect(path(landed.container).getAttribute("stroke-dasharray")).toBeNull();
  });

  it("合法目标是品牌色，非法目标是危险色，悬空是中性灰", () => {
    const cases: [
      "valid" | "invalid" | null,
      ReturnType<typeof internalNode> | null,
      string,
    ][] = [
      ["valid", internalNode(300, 0), "var(--brand)"],
      ["invalid", internalNode(300, 0), "var(--danger)"],
      [null, null, "var(--muted-foreground)"],
    ];
    for (const [status, toNode, colour] of cases) {
      const { container } = renderLine(toNode, status);
      expect(path(container).getAttribute("stroke")).toBe(colour);
      cleanup();
    }
  });

  it("线宽走样式，不写 strokeWidth 属性", () => {
    const { container } = renderLine(internalNode(300, 0));
    expect(path(container).hasAttribute("stroke-width")).toBe(false);
    expect(path(container).style.strokeWidth).toBe("2");
  });

  it("吸到目标上的终点圆点标 data-snapped，悬空时不标", () => {
    const landed = renderLine(internalNode(300, 0), "valid");
    expect(
      landed.container.querySelector("circle")?.getAttribute("data-snapped"),
    ).toBe("true");
    cleanup();
    const loose = renderLine(null);
    expect(
      loose.container.querySelector("circle")?.hasAttribute("data-snapped"),
    ).toBe(false);
  });

  it("目标不可连接时终点圆点抖动（anim-shake），其余状态不抖", () => {
    const invalid = renderLine(internalNode(300, 0), "invalid");
    expect(
      invalid.container.querySelector("circle")?.getAttribute("class"),
    ).toContain("anim-shake");
    cleanup();
    const valid = renderLine(internalNode(300, 0), "valid");
    expect(
      valid.container.querySelector("circle")?.getAttribute("class") ?? "",
    ).not.toContain("anim-shake");
  });
});
