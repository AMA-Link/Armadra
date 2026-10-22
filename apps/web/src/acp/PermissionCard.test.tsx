import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

import { useAgentStatusStore } from "@/agent/status-store";
import { PermissionCard } from "./PermissionCard";
import { useAnsweredStore } from "./answered";
import type { AcpPermissionView } from "./approval-views";

const permission: AcpPermissionView = {
  pendingId: "n1-1-acp-t1",
  toolCall: { toolCallId: "t1", title: "pnpm test" },
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ],
};

beforeEach(() => {
  api.answer.mockReset().mockResolvedValue({});
  useAnsweredStore.getState().reset();
});

afterEach(cleanup);

describe("PermissionCard", () => {
  it("orders by kind: only the one-time allow is primary, reject sits apart", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    expect(screen.getByText("pnpm test")).toBeTruthy();
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-slot=approval-actions] button",
      ),
    ];
    // Agent 把「始终允许」放在第一个，卡片仍把「本次允许」排前面。
    expect(
      buttons.map((button) => [button.textContent, button.dataset.variant]),
    ).toEqual([
      ["本次允许", "default"],
      ["始终允许", "outline"],
      ["拒绝", "outline"],
    ]);
    const [lead, tail] = document.querySelectorAll(
      "[data-slot=approval-actions] > div",
    ) as unknown as [HTMLElement, HTMLElement];
    expect(lead.querySelectorAll("button")).toHaveLength(2);
    expect(tail.querySelectorAll("button")).toHaveLength(1);
  });

  it("names the card by its title and exposes the options as shortcuts", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    const card = screen.getByRole("group", { name: "pnpm test" });
    expect(card.getAttribute("data-slot")).toBe("acp-permission");
    expect(
      [...card.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-keyshortcuts"),
      ),
    ).toEqual(["1", "2", "3"]);
    // 警示图标不进读屏。
    expect(card.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("answers with the digit keys while focus is inside the card", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    const button = screen.getByRole("button", { name: "本次允许" });
    // 带修饰键、超出范围的数字都不答。
    fireEvent.keyDown(button, { key: "1", metaKey: true });
    fireEvent.keyDown(button, { key: "9" });
    expect(api.answer).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "3" });
    expect(api.answer).toHaveBeenCalledWith("n1-1-acp-t1", "deny", "no");
  });

  it("hands focus back after answering from inside the card", () => {
    const onAnswered = vi.fn();
    render(
      <PermissionCard
        permission={permission}
        canAnswer
        pinned
        onAnswered={onAnswered}
      />,
    );
    expect(document.activeElement?.textContent).toBe("本次允许");
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it("shows a command in monospace, clamped, and expands on press", () => {
    const command = `git push --force-with-lease origin main && ${"x".repeat(200)}`;
    render(
      <PermissionCard
        permission={{
          ...permission,
          toolCall: { toolCallId: "t1", title: command, kind: "execute" },
        }}
        canAnswer
      />,
    );
    const toggle = screen.getByRole("button", { name: /git push/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const code = toggle.querySelector("code") as HTMLElement;
    expect(code.className).toContain("font-mono");
    expect(code.className).toContain("line-clamp-3");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(code.className).not.toContain("line-clamp-3");
  });

  it("keeps a short command as plain monospace text", () => {
    render(
      <PermissionCard
        permission={{
          ...permission,
          toolCall: { toolCallId: "t1", title: "ls -la", kind: "execute" },
        }}
        canAnswer
      />,
    );
    expect(screen.getByText("ls -la").tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: "ls -la" })).toBeNull();
  });

  it("answers once with the option and collapses everywhere", () => {
    const resolveApproval = vi.spyOn(
      useAgentStatusStore.getState(),
      "resolveApproval",
    );
    render(<PermissionCard permission={permission} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(api.answer).toHaveBeenCalledTimes(1);
    expect(api.answer).toHaveBeenCalledWith("n1-1-acp-t1", "deny", "no");
    expect(useAnsweredStore.getState().ids.has("n1-1-acp-t1")).toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith("n1-1-acp-t1");
  });

  it("shows only the title to someone who cannot answer", () => {
    render(<PermissionCard permission={permission} canAnswer={false} />);
    expect(screen.getByRole("group", { name: "pnpm test" })).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // 同一张卡，按钮换成徽标（设计系统 §5.8）。
    expect(screen.getByText("等待接管")).toBeTruthy();
  });

  it("expands details with the diff, the input and the files before answering", () => {
    const detailed: AcpPermissionView = {
      ...permission,
      toolCall: {
        toolCallId: "t1",
        title: "Edit a.ts",
        locations: [{ path: "/repo/a.ts", line: 3 }],
        rawInput: { path: "a.ts", content: "new" },
        content: [
          { type: "diff", path: "/elsewhere/a.ts", oldText: "x", newText: "y" },
        ],
      },
    };
    render(<PermissionCard permission={detailed} canAnswer />);
    expect(screen.queryByText("/repo/a.ts:3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("/repo/a.ts:3")).toBeTruthy();
    expect(screen.getByText("/elsewhere/a.ts")).toBeTruthy();
    expect(screen.getByText(/"content": "new"/)).toBeTruthy();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("puts focus on the first allow when pinned, unless someone is typing", () => {
    render(<PermissionCard permission={permission} canAnswer pinned />);
    expect(document.activeElement?.textContent).toBe("本次允许");
    cleanup();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    render(<PermissionCard permission={permission} canAnswer pinned />);
    expect(document.activeElement).toBe(field);
    // Esc 不答。
    fireEvent.keyDown(screen.getByRole("button", { name: "本次允许" }), {
      key: "Escape",
    });
    expect(api.answer).not.toHaveBeenCalled();
    field.remove();
  });
});
