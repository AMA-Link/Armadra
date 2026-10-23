import { describe, expect, it } from "vitest";
import { cn as bare } from "cn";

import { cn } from "./cn";

describe("cn 认得设计系统的类名", () => {
  it("字号类与颜色类互不吃掉", () => {
    expect(cn("text-meta", "text-danger-text")).toBe(
      "text-meta text-danger-text",
    );
    expect(cn("text-danger-text", "text-meta")).toBe(
      "text-danger-text text-meta",
    );
  });

  it("字号档位之间按调用者的意图覆盖，包括 Tailwind 刻度", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("text-sm", "text-body")).toBe("text-body");
  });

  it("七档语义圆角与 shadcn 圆角互相覆盖", () => {
    expect(cn("rounded-control", "rounded-full")).toBe("rounded-full");
    expect(cn("rounded-lg", "rounded-card")).toBe("rounded-card");
    expect(cn("rounded-card", "rounded-pill")).toBe("rounded-pill");
  });

  it("三档阴影互相覆盖", () => {
    expect(cn("shadow-overlay", "shadow-dialog")).toBe("shadow-dialog");
    expect(cn("shadow-md", "shadow-node")).toBe("shadow-node");
  });

  it("z 轴令牌写法同组覆盖", () => {
    expect(cn("z-(--z-dialog)", "z-[var(--z-menu)]")).toBe("z-[var(--z-menu)]");
  });

  it("裸 `cn`（npm 包）在测试与构建里别名到这里", () => {
    expect(bare("text-meta", "text-danger-text")).toBe(
      "text-meta text-danger-text",
    );
  });
});
