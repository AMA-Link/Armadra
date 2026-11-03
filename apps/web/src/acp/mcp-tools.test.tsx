import { ARMADRA_MCP_TOOLS } from "@armadra/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import { toolItem } from "@/timeline/view/fixtures";
import { ToolRow } from "@/timeline/view/rows/ToolRow";
import {
  ARMADRA_TOOL_ICONS,
  FOREIGN_MCP_ICON,
  armadraToolKey,
  mcpToolDisplay,
} from "./mcp-tools";

const zh = (key: string, values?: Record<string, string | number>) =>
  translate("zh-CN", key, values);
const en = (key: string, values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("Armadra's own MCP tools (#768)", () => {
  it("has zh and en copy and an icon for every tool in VERB_TOOLS", () => {
    for (const tool of ARMADRA_MCP_TOOLS) {
      const key = armadraToolKey(tool);
      expect(zh(key), tool).not.toBe(key);
      expect(en(key), tool).not.toBe(key);
      expect(zh(key)).not.toMatch(/mcp|armadra|_/);
      expect(ARMADRA_TOOL_ICONS[tool], tool).toBeTruthy();
    }
    expect(Object.keys(ARMADRA_TOOL_ICONS).sort()).toEqual(
      [...ARMADRA_MCP_TOOLS].sort(),
    );
  });

  it("maps the examples to friendly titles", () => {
    const title = (tool: string, t = zh) =>
      mcpToolDisplay({ server: "armadra", tool }, t)?.title;
    expect(title("canvas_wait")).toBe("等待成员");
    expect(title("context_terminal")).toBe("读取终端");
    expect(title("canvas_post")).toBe("发送消息");
    expect(title("canvas_wait", en)).toBe("Wait for member");
    expect(
      mcpToolDisplay({ server: "armadra", tool: "canvas_wait" }, zh)?.own,
    ).toBe(true);
  });

  it("shows another server's tool as server · tool with a plug", () => {
    const display = mcpToolDisplay({ server: "notes", tool: "search" }, zh);
    expect(display).toMatchObject({
      title: "notes · search",
      Icon: FOREIGN_MCP_ICON,
      own: false,
    });
    // 我们的服务器名配上不在清单里的工具：也是「别家」的写法，不冒充自家。
    expect(
      mcpToolDisplay({ server: "armadra", tool: "rm_rf" }, zh),
    ).toMatchObject({ title: "armadra · rm_rf", own: false });
    expect(mcpToolDisplay(undefined, zh)).toBeNull();
  });
});

describe("ToolRow with an MCP call", () => {
  it("never shows the raw mcp.* id", () => {
    const { container } = render(
      <ToolRow
        item={toolItem(1, "m1", {
          title: "mcp.armadra.context_terminal",
          toolKind: "execute",
          mcp: { server: "armadra", tool: "context_terminal" },
        })}
      />,
    );
    expect(container.textContent).toContain("读取终端");
    expect(container.textContent).not.toContain("mcp.armadra");
    expect(container.querySelector(".font-mono")?.textContent ?? "").not.toBe(
      "读取终端",
    );
  });

  it("falls back to the adapter's title without provenance", () => {
    const { container } = render(
      <ToolRow
        item={toolItem(1, "x1", {
          title: "mcp.armadra.canvas_wait",
          toolKind: "execute",
        })}
      />,
    );
    expect(container.textContent).toContain("mcp.armadra.canvas_wait");
  });
});
