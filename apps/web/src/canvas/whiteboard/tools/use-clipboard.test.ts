import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 复制与剪切的提示：复制看不出结果，弹一条；剪切时对象随即从画布上消失，
 * 结果已经可见，不再弹成功提示。
 */
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/ui/toast", () => ({ toast }));

const removeItems = vi.hoisted(() => vi.fn());
const removeNodes = vi.hoisted(() => vi.fn());
vi.mock("../store", () => ({
  addItems: vi.fn(),
  createItemId: () => "new-id",
  itemsByIds: () => [
    {
      id: "item-1",
      kind: "shape",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      z: 0,
      style: { color: "black", size: "m" },
    },
  ],
  removeItems,
  select: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      selectedItemIds: ["item-1"],
      selectedNodeIds: [],
      document: { nodes: [] },
      whiteboard: { references: [] },
      removeNodes,
    }),
  },
}));
vi.mock("../../dnd/external-content", () => ({
  addBrowserFiles: vi.fn(),
  routeFile: vi.fn(),
}));
vi.mock("../../interaction/pointer", () => ({ pastePoint: vi.fn() }));
vi.mock("../mermaid/open", () => ({ openMermaidImport: vi.fn() }));

const { copySelection, resetLocalClipboard } = await import("./use-clipboard");

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalClipboard();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("复制与剪切的提示", () => {
  it("复制弹一条成功提示", async () => {
    await copySelection(false);
    expect(toast.success).toHaveBeenCalledOnce();
    expect(removeItems).not.toHaveBeenCalled();
  });

  it("剪切删掉选中的对象，不弹成功提示", async () => {
    await copySelection(true);
    expect(toast.success).not.toHaveBeenCalled();
    expect(removeItems).toHaveBeenCalledWith(["item-1"]);
  });
});
