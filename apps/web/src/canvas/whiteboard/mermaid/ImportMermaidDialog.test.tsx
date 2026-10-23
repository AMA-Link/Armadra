import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/ui/toast", () => ({ toast }));

const importMermaidText = vi.hoisted(() => vi.fn());
const createImageShapes = vi.hoisted(() => vi.fn());
vi.mock("./import", () => ({ importMermaidText }));
vi.mock("../../dnd/external-content", () => ({ createImageShapes }));
vi.mock("../../interaction/pointer", () => ({
  viewportCentre: () => ({ x: 0, y: 0 }),
}));
vi.mock("./render", () => ({
  renderMermaidSvg: vi.fn().mockResolvedValue("<svg></svg>"),
  svgToFile: () => new File(["x"], "x.svg"),
}));

import { ImportMermaidDialog } from "./ImportMermaidDialog";
import {
  getMermaidDialog,
  openMermaidImport,
  resetMermaidDialog,
} from "./open";

installDomPolyfills();

beforeEach(() => {
  vi.clearAllMocks();
  openMermaidImport({ text: "flowchart LR\n A --> B" });
});
afterEach(() => {
  cleanup();
  resetMermaidDialog();
});

describe("导入 Mermaid 对话框", () => {
  it("没有说明段落", () => {
    render(<ImportMermaidDialog />);
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toBe(
      null,
    );
    expect(
      document.querySelector('[data-slot="dialog-description"]'),
    ).toBeNull();
  });

  it("流程图落成图形后关闭对话框，不弹成功提示", async () => {
    importMermaidText.mockResolvedValue({ kind: "graph", ids: ["a", "b"] });
    render(<ImportMermaidDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /导入$|Import$/ }));
    });
    expect(importMermaidText).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(getMermaidDialog().open).toBe(false);
  });

  it("其余图种按图片导入，用一条普通提示说明", async () => {
    importMermaidText.mockResolvedValue({
      kind: "image",
      diagramType: "sequence",
    });
    render(<ImportMermaidDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /导入$|Import$/ }));
    });
    expect(createImageShapes).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledOnce();
  });
});
