import type { LabelBox } from "@armadra/board/core";

/**
 * 线上的关系标签：一枚纸色底、线色描边的小胶囊。
 *
 * 文字用线自己的颜色而不是 `--foreground`：画布纸张色是用户单独选的
 * （`--canvas-bg`），深色主题下也可能是一张浅色纸。底色就是纸色，所以线
 * 从胶囊下面穿过去时不会划过字。不接收指针：点它等于点画布。
 */
export function EdgeLabel({ box, text }: { box: LabelBox; text: string }) {
  return (
    <g data-slot="edge-label" pointerEvents="none">
      <rect
        x={box.x - box.width / 2}
        y={box.y - box.height / 2}
        width={box.width}
        height={box.height}
        rx={box.height / 2}
        fill="var(--canvas-bg)"
        stroke="currentColor"
        strokeOpacity={0.4}
        style={{ strokeWidth: box.fontSize / 11 }}
      />
      <text
        x={box.x}
        y={box.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={box.fontSize}
        fill="currentColor"
        // `text-caption` 的等宽写法：SVG 里没有类可套，字体取 `--font-code`，
        // 宽度估算（`edge-label.textWidth`）正好是 0.6em 一个字符。
        style={{
          userSelect: "none",
          fontWeight: "var(--fw-medium)",
          fontFamily: "var(--font-code)",
        }}
      >
        {text}
      </text>
    </g>
  );
}
