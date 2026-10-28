import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { EdgeLabel } from "./EdgeLabel";

afterEach(cleanup);

describe("EdgeLabel", () => {
  const box = { x: 100, y: 50, width: 60, height: 15, fontSize: 11 };

  it("标签字用等宽字体、medium 字重令牌（text-caption 的 SVG 写法）", () => {
    const { container } = render(
      <svg>
        <EdgeLabel box={box} text="共享上下文" />
      </svg>,
    );
    const text = container.querySelector("text") as SVGTextElement;
    expect(text.style.fontFamily).toBe("var(--font-code)");
    expect(text.style.fontWeight).toBe("var(--fw-medium)");
    expect(text.getAttribute("font-size")).toBe("11");
  });

  it("底是纸色，描边走样式，不接指针", () => {
    const { container } = render(
      <svg>
        <EdgeLabel box={box} text="引用" />
      </svg>,
    );
    const rect = container.querySelector("rect") as SVGRectElement;
    expect(rect.getAttribute("fill")).toBe("var(--canvas-bg)");
    expect(rect.hasAttribute("stroke-width")).toBe(false);
    expect(rect.style.strokeWidth).toBe("1");
    expect(
      container
        .querySelector('[data-slot="edge-label"]')
        ?.getAttribute("pointer-events"),
    ).toBe("none");
  });
});
