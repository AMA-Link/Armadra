import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { roundedPath, routeFor } from "@armadra/board/core";
import { CORNER_RADIUS } from "./link-visual";
import { ConnectionPath } from "./ConnectionPath";

/**
 * 拖线时的预览：预览与落成后的连线**必须是同一条曲线**，否则松手那一刻线会突然
 * 弹到别处。
 */

afterEach(cleanup);

const box = (x: number, y: number) => ({ x, y, width: 100, height: 100 });

function renderLine(
  to: { x: number; y: number; width: number; height: number } | null,
  status: "valid" | "invalid" | null = null,
) {
  return render(
    <svg>
      <ConnectionPath
        from={box(0, 0)}
        // 悬空时把指针当成零尺寸矩形。
        to={to ?? { x: 300, y: 50, width: 0, height: 0 }}
        snapped={to !== null}
        status={status}
      />
    </svg>,
  );
}

function path(container: HTMLElement): SVGPathElement {
  return container.querySelector(
    '[data-slot="connection-line"] path',
  ) as SVGPathElement;
}

describe("ConnectionPath", () => {
  it("落在目标上时画的就是落成后那种线", () => {
    const { container } = renderLine(box(300, 0));
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

    const landed = renderLine(box(300, 0));
    expect(path(landed.container).getAttribute("stroke-dasharray")).toBeNull();
  });

  it("合法目标是品牌色，非法目标是危险色，悬空是中性灰", () => {
    const cases: [
      "valid" | "invalid" | null,
      ReturnType<typeof box> | null,
      string,
    ][] = [
      ["valid", box(300, 0), "var(--brand)"],
      ["invalid", box(300, 0), "var(--danger)"],
      [null, null, "var(--muted-foreground)"],
    ];
    for (const [status, toNode, colour] of cases) {
      const { container } = renderLine(toNode, status);
      expect(path(container).getAttribute("stroke")).toBe(colour);
      cleanup();
    }
  });

  it("线宽走样式，不写 strokeWidth 属性", () => {
    const { container } = renderLine(box(300, 0));
    expect(path(container).hasAttribute("stroke-width")).toBe(false);
    expect(path(container).style.strokeWidth).toBe("2");
  });

  it("吸到目标上的终点圆点标 data-snapped，悬空时不标", () => {
    const landed = renderLine(box(300, 0), "valid");
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
    const invalid = renderLine(box(300, 0), "invalid");
    expect(
      invalid.container.querySelector("circle")?.getAttribute("class"),
    ).toContain("anim-shake");
    cleanup();
    const valid = renderLine(box(300, 0), "valid");
    expect(
      valid.container.querySelector("circle")?.getAttribute("class") ?? "",
    ).not.toContain("anim-shake");
  });
});
