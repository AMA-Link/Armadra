import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";

const api = vi.hoisted(() => ({
  files: vi.fn(),
  importFile: vi.fn(),
}));

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  workflowsApi: api,
}));

const { ImportWorkflowDialog } = await import("./ImportWorkflowDialog");

/** 导入对话框（契约 §121）：无效的行禁用，已导入的按钮是「更新」。 */

const FILES = [
  {
    id: "fresh",
    path: ".ama/workflows/fresh.md",
    title: "新的",
    valid: true,
    error: null,
    templateId: null,
  },
  {
    id: "known",
    path: ".ama/workflows/known.md",
    title: "已导入的",
    valid: true,
    error: null,
    templateId: "tpl-1",
  },
  {
    id: "broken",
    path: ".ama/workflows/broken.md",
    title: null,
    valid: false,
    error: "steps: 缺步骤",
    templateId: null,
  },
];

function show(workspaceId: string | null = "ws") {
  return render(
    <TestProviders>
      <ImportWorkflowDialog open workspaceId={workspaceId} onClose={() => {}} />
    </TestProviders>,
  );
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-file-id="${id}"]`)!;

beforeAll(() => installDomPolyfills());
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  usePreferencesStore.getState().setLocale("zh-CN");
});
afterEach(() => cleanup());

describe("ImportWorkflowDialog", () => {
  it("每个文件一行：无效的禁用，已导入的按钮是「更新」", async () => {
    api.files.mockResolvedValue(FILES);
    show();
    await screen.findByText("新的");
    expect(api.files).toHaveBeenCalledWith("ws");
    expect(within(row("fresh")).getByText("导入")).toBeTruthy();
    expect(within(row("known")).getByText("更新")).toBeTruthy();
    const broken = within(row("broken")).getByRole("button");
    expect(broken.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(broken);
    expect(api.importFile).not.toHaveBeenCalled();
    expect(row("broken").dataset.valid).toBe("false");
    expect(
      within(row("fresh")).getByRole("button").hasAttribute("disabled"),
    ).toBe(false);
  });

  it("点导入带工作空间与文件 id，成功后重读列表", async () => {
    api.files.mockResolvedValue(FILES);
    api.importFile.mockResolvedValue({
      template: {},
      change: "created",
    });
    show();
    await screen.findByText("新的");
    fireEvent.click(within(row("fresh")).getByRole("button"));
    await waitFor(() =>
      expect(api.importFile).toHaveBeenCalledWith("ws", "fresh"),
    );
    await waitFor(() => expect(api.files).toHaveBeenCalledTimes(2));
  });

  it("没有文件时只有一句话；读取失败出提示", async () => {
    api.files.mockResolvedValue([]);
    const { unmount } = show();
    expect(await screen.findByText("没有工作流文件")).toBeTruthy();
    unmount();
    api.files.mockRejectedValue(new Error("boom"));
    show();
    expect(await screen.findByText("操作没有成功，再试一次")).toBeTruthy();
  });

  it("英文文案", async () => {
    usePreferencesStore.getState().setLocale("en");
    api.files.mockResolvedValue(FILES);
    show();
    await screen.findByText("新的");
    expect(within(row("fresh")).getByText("Import")).toBeTruthy();
    expect(within(row("known")).getByText("Update")).toBeTruthy();
    expect(screen.getByText("Import workflow files")).toBeTruthy();
  });

  it("没有工作空间时不读", () => {
    show(null);
    expect(api.files).not.toHaveBeenCalled();
  });
});
