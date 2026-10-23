import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { translate } from "../i18n";
import {
  COMMANDS,
  commandKeysLabel,
  setShortcutsEnabled,
} from "../keybindings";
import { useCanvasStore } from "../store/canvas-store";
import { CommandPalette } from "./CommandPalette";

/**
 * 键盘优先（设计系统 §11.2）：命令表是快捷键的唯一登记处，命令面板把表里每一条
 * 都列出来，右侧用 `Kbd` 显示它此刻生效的键。新增命令、改默认键、换语言之后，
 * 这条测试保证「登记了的键，面板里看得到」，没有键的命令也不会冒出一个空 Kbd。
 */

vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: vi.fn().mockResolvedValue([]),
    settings: vi.fn().mockResolvedValue({ ssh: { hosts: [] } }),
    conversations: vi.fn().mockResolvedValue([]),
  },
}));

const timestamp = "2026-09-04T10:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

beforeAll(installDomPolyfills);

beforeEach(() => {
  setShortcutsEnabled(true);
  localStorage.clear();
  useCanvasStore.setState({
    workspace,
    document: null,
    selectedNodeIds: [],
    panels: { ...useCanvasStore.getState().panels, palette: true },
  });
});

afterEach(cleanup);

/** 面板里「命令」那一组的行，顺序同命令表（没输入、没有最近）。 */
function commandRows(): HTMLElement[] {
  const groups = [
    ...window.document.querySelectorAll<HTMLElement>("[cmdk-group]"),
  ];
  const group = groups.at(-1);
  return [...(group?.querySelectorAll<HTMLElement>("[cmdk-item]") ?? [])];
}

describe("命令面板里每条命令都显示它的快捷键", () => {
  const listed = COMMANDS.filter(
    (command) => command.id !== "app.commandPalette",
  );

  it("命令表里的每一条都在面板里，顺序一致", () => {
    render(<CommandPalette />, { wrapper: TestProviders });
    const rows = commandRows();
    expect(rows).toHaveLength(listed.length);
    rows.forEach((row, index) => {
      expect(row.textContent).toContain(
        translate("zh-CN", listed[index]!.labelKey),
      );
    });
  });

  it("有键的命令右侧是一个 Kbd，内容等于命令表现在生效的键；没键的没有 Kbd", () => {
    render(<CommandPalette />, { wrapper: TestProviders });
    const rows = commandRows();
    const missing: string[] = [];
    rows.forEach((row, index) => {
      const command = listed[index]!;
      const keys = commandKeysLabel(command.id);
      const kbds = [...row.querySelectorAll("kbd")];
      if (keys === "") {
        if (kbds.length > 0) missing.push(`${command.id}: 没有键却画了 Kbd`);
        return;
      }
      if (kbds.length !== 1 || kbds[0]!.textContent !== keys)
        missing.push(`${command.id}: 期望 ${keys}`);
    });
    expect(missing).toEqual([]);
  });

  it("总开关关着时一个 Kbd 都不画：按下去不会生效的键不该写在菜单上", () => {
    setShortcutsEnabled(false);
    render(<CommandPalette />, { wrapper: TestProviders });
    for (const row of commandRows())
      expect(row.querySelector("kbd")).toBeNull();
  });

  it("命令表至少有一批带默认键的命令（防止这条测试空跑）", () => {
    const withKeys = listed.filter(
      (command) => commandKeysLabel(command.id) !== "",
    );
    expect(withKeys.length).toBeGreaterThan(20);
  });
});
