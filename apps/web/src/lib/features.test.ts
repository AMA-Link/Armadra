import { describe, expect, it } from "vitest";
import {
  boardDocumentSchema,
  type CanvasNode,
  type Workspace,
} from "@armadra/shared";

import { featureEnabled, panelHidden } from "./features";
import {
  activeSectionId,
  isSettingsSectionId,
  visibleSettingsSections,
} from "../panels/settings/nav";
import { buildAddMenu } from "../canvas/menus/add-menu";
import { useCanvasStore } from "../store/canvas-store";

/**
 * 暂时下线的五项功能（#295）：用真实的开关（不 mock），断言各入口都不在、
 * 旧数据照常加载。恢复时改 `packages/shared/src/feature-flags.ts`，这里的
 * 断言跟着改。
 */

const timestamp = "2026-10-11T00:00:00.000Z";
const BOARD_ID = "019ff7d1-0d12-7421-833d-2c5e8d64ed30";
const TERMINAL_ID = "33333333-3333-4333-8333-333333333333";

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

describe("功能开关（#295）", () => {
  it("五项都关着，对应的工作面板算作隐藏", () => {
    for (const flag of [
      "credentials",
      "usage",
      "activityCards",
      "scheduledTasks",
      "workflows",
    ] as const)
      expect(featureEnabled(flag), flag).toBe(false);
    for (const panel of ["automation", "workflow", "usage"])
      expect(panelHidden(panel), panel).toBe(true);
    for (const panel of ["explorer", "scm", "resources", "dispatch"])
      expect(panelHidden(panel), panel).toBe(false);
  });

  it("设置导航不列凭据与用量；存着的旧分区落回首页", () => {
    for (const member of [false, true]) {
      const ids = visibleSettingsSections(true, member).map((s) => s.id);
      expect(ids).not.toContain("credentials");
      expect(ids).not.toContain("usage");
    }
    expect(isSettingsSectionId("credentials")).toBe(false);
    expect(activeSectionId("usage")).toBe("defaults");
    // 上一版的「账号」映射到用量页，这时也落回首页而不是一页空白。
    expect(activeSectionId("account")).toBe("defaults");
  });

  it("新建菜单（画布右键、Dock +、命令面板共用）不列三项", () => {
    const ids = buildAddMenu([], (key) => key, [], true).map((item) => item.id);
    expect(ids).not.toContain("add.automation");
    expect(ids).not.toContain("add.workflow");
    expect(ids).not.toContain("add.agentActivity");
    expect(ids).toContain("add.sticky");
  });

  it("自动化、工作流、用量面板打不开；关照常关，其它面板不受影响", () => {
    const { setPanel } = useCanvasStore.getState();
    setPanel("automation", "drawer");
    setPanel("workflow", "drawer");
    setPanel("usage", "drawer");
    setPanel("usage", "pinned");
    const panels = () => useCanvasStore.getState().panels;
    expect(panels().automation).toBe("closed");
    expect(panels().workflow).toBe("closed");
    expect(panels().usage).toBe("closed");
    setPanel("automation", "closed");
    expect(panels().automation).toBe("closed");
    setPanel("resources", "drawer");
    expect(panels().resources).toBe("drawer");
    setPanel("resources", "closed");
  });

  it("含定时计划卡片与活动卡片的旧画布照常解析、载入", () => {
    const base = {
      boardId: BOARD_ID,
      color: "#0a84ff",
      position: { x: 0, y: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const wire = {
      board: {
        id: BOARD_ID,
        workspaceId: workspace.id,
        name: "Default",
        sortOrder: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      nodes: [
        {
          ...base,
          id: TERMINAL_ID,
          type: "terminal",
          title: "Claude",
          data: { kind: "terminal" },
        },
        {
          ...base,
          id: "44444444-4444-4444-8444-444444444444",
          type: "agentActivity",
          title: "Claude",
          data: {
            kind: "agentActivity",
            sourceNodeId: TERMINAL_ID,
            source: "loop",
            sessionId: "",
            executionHostId: "",
            generation: 0,
          },
        },
        {
          ...base,
          id: "55555555-5555-4555-8555-555555555555",
          type: "automation",
          title: "Nightly",
          data: {
            kind: "automation",
            planId: "plan-1",
            planWorkspaceId: workspace.id,
            executionHostId: "host-1",
          },
        },
      ],
      edges: [],
    };
    const document = boardDocumentSchema.parse(wire);
    useCanvasStore.getState().setWorkspace(workspace);
    useCanvasStore.getState().setDocument(document);
    const types = (useCanvasStore.getState().document?.nodes ?? []).map(
      (node: CanvasNode) => node.type,
    );
    expect(types).toEqual(["terminal", "agentActivity", "automation"]);
  });
});
