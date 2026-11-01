import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "../../../app/preferences-store";
import { scoped } from "../../../sources/scope";

const api = vi.hoisted(() => ({
  listArchivedWorkspaces: vi.fn(),
  restoreWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ runtimeApi: api }));

import { ArchivePage } from "./ArchivePage";

const timestamp = "2026-11-01T08:00:00.000Z";
const archived = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp,
};

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ArchivePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN", openWorkspaceKeys: [] });
  api.listArchivedWorkspaces.mockReset().mockResolvedValue([archived]);
  api.restoreWorkspace.mockReset().mockResolvedValue(archived);
  api.deleteWorkspace.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("设置 → 归档（契约 §89）", () => {
  it("列出已归档的工作空间；恢复把它放回侧栏", async () => {
    draw();
    expect(await screen.findByText("repo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(api.restoreWorkspace).toHaveBeenCalledWith(archived.id),
    );
    await waitFor(() =>
      expect(usePreferencesStore.getState().openWorkspaceKeys).toEqual([
        scoped(archived.id),
      ]),
    );
    expect(api.listArchivedWorkspaces.mock.calls.length).toBeGreaterThan(1);
  });

  it("删除一步完成，不弹确认", async () => {
    draw();
    await screen.findByText("repo");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(api.deleteWorkspace).toHaveBeenCalledWith(archived.id),
    );
  });

  it("一个都没有时只有一行空态", async () => {
    api.listArchivedWorkspaces.mockResolvedValue([]);
    draw();
    expect(await screen.findByText("没有已归档的工作空间")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
