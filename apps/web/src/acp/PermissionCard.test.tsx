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
    { optionId: "never", name: "Never", kind: "reject_always" },
  ],
};

const actionButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>(
    "[data-slot=approval-actions] button[data-option]",
  ),
];

const pickScope = (name: "本次" | "始终") =>
  fireEvent.mouseDown(screen.getByRole("tab", { name }));

beforeEach(() => {
  api.answer.mockReset().mockResolvedValue({});
  useAnsweredStore.getState().reset();
});

afterEach(cleanup);

describe("PermissionCard", () => {
  it("folds the four kinds into a once / always segment and two buttons", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    expect(screen.getByText("pnpm test")).toBeTruthy();
    // Agent 把「始终允许」放在第一个，卡片仍以「本次」起头。
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "本次",
      "始终",
    ]);
    expect(
      screen.getByRole("tab", { name: "本次" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      actionButtons().map((button) => [
        button.textContent,
        button.dataset.variant,
        button.dataset.option,
      ]),
    ).toEqual([
      ["拒绝Esc", "outline", "reject_once"],
      ["允许↵", "default", "allow_once"],
    ]);
    // 拒绝在左、允许在右（同一行靠末端，隔开一个行距）。
    const [lead, tail] = document.querySelectorAll(
      "[data-slot=approval-actions] > div",
    ) as unknown as [HTMLElement, HTMLElement];
    expect(lead.querySelector("[role=tablist]")).not.toBeNull();
    expect(tail.querySelectorAll("button")).toHaveLength(2);
  });

  it("maps the segment to the four kinds: once and always, allow and reject", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    pickScope("始终");
    expect(
      actionButtons().map((button) => [
        button.dataset.option,
        button.dataset.variant,
      ]),
    ).toEqual([
      ["reject_always", "destructive"],
      ["allow_always", "default"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^允许/ }));
    expect(api.answer).toHaveBeenLastCalledWith(
      "n1-1-acp-t1",
      "allow",
      "always",
    );
    cleanup();
    render(<PermissionCard permission={permission} canAnswer />);
    pickScope("始终");
    fireEvent.click(screen.getByRole("button", { name: /^拒绝/ }));
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "deny", "never");
    cleanup();
    render(<PermissionCard permission={permission} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: /^允许/ }));
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "allow", "once");
    cleanup();
    render(<PermissionCard permission={permission} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: /^拒绝/ }));
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "deny", "no");
  });

  it("draws no segment when the agent offers one scope only", () => {
    render(
      <PermissionCard
        permission={{
          ...permission,
          options: [
            { optionId: "once", name: "Once", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        }}
        canAnswer
      />,
    );
    expect(screen.queryByRole("tab")).toBeNull();
    expect(actionButtons()).toHaveLength(2);
  });

  it("falls back to the reject it has when the always scope has none", () => {
    render(
      <PermissionCard
        permission={{
          ...permission,
          options: [
            { optionId: "once", name: "Once", kind: "allow_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        }}
        canAnswer
      />,
    );
    pickScope("始终");
    fireEvent.click(screen.getByRole("button", { name: /^拒绝/ }));
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "deny", "no");
  });

  it("shows the risk badge only for execute, delete and move", () => {
    for (const kind of ["execute", "delete", "move"] as const) {
      render(
        <PermissionCard
          permission={{
            ...permission,
            toolCall: { toolCallId: "t1", title: "x", kind },
          }}
          canAnswer
        />,
      );
      expect(screen.getByText("有风险").dataset.variant).toBe("warn");
      cleanup();
    }
    for (const kind of ["read", "edit", "search", "fetch", "other"] as const) {
      render(
        <PermissionCard
          permission={{
            ...permission,
            toolCall: { toolCallId: "t1", title: "x", kind },
          }}
          canAnswer
        />,
      );
      expect(screen.queryByText("有风险")).toBeNull();
      cleanup();
    }
    render(<PermissionCard permission={permission} canAnswer />);
    expect(screen.queryByText("有风险")).toBeNull();
  });

  it("lists the files that will change with their +N −M", () => {
    render(
      <PermissionCard
        permission={{
          ...permission,
          toolCall: {
            toolCallId: "t1",
            title: "Edit",
            kind: "edit",
            locations: [
              { path: "/repo/src/x.ts" },
              { path: "/repo/README.md", line: 4 },
            ],
            content: [
              {
                type: "diff",
                path: "/repo/src/x.ts",
                oldText: "a\nb\n",
                newText: "a\nc\nd\n",
              },
            ],
          },
        }}
        canAnswer
      />,
    );
    const row = document.querySelector("[data-slot=approval-changes]")!;
    const chips = [...row.querySelectorAll("[data-slot=badge]")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "x.ts+2−1",
      "README.md:4",
    ]);
  });

  it("names the card by its title and exposes the keys as shortcuts", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    const card = screen.getByRole("group", { name: "pnpm test" });
    expect(card.getAttribute("data-slot")).toBe("acp-permission");
    expect(
      actionButtons().map((button) => button.getAttribute("aria-keyshortcuts")),
    ).toEqual(["Escape", "Enter"]);
    // 警示图标不进读屏。
    expect(card.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("answers with the digit keys in kind order while focus is inside the card", () => {
    render(<PermissionCard permission={permission} canAnswer />);
    const button = screen.getByRole("button", { name: /^允许/ });
    // 带修饰键、超出范围的数字都不答。
    fireEvent.keyDown(button, { key: "1", metaKey: true });
    fireEvent.keyDown(button, { key: "9" });
    expect(api.answer).not.toHaveBeenCalled();
    // 顺序：1 本次允许、2 始终允许、3 拒绝、4 始终拒绝。
    fireEvent.keyDown(button, { key: "3" });
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "deny", "no");
    fireEvent.keyDown(button, { key: "2" });
    expect(api.answer).toHaveBeenLastCalledWith(
      "n1-1-acp-t1",
      "allow",
      "always",
    );
    fireEvent.keyDown(button, { key: "4" });
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "deny", "never");
  });

  it("allows with Enter on the segment and rejects with Esc anywhere in the card", () => {
    const onAnswered = vi.fn();
    render(
      <PermissionCard
        permission={permission}
        canAnswer
        onAnswered={onAnswered}
      />,
    );
    const tab = screen.getByRole("tab", { name: "本次" });
    tab.focus();
    fireEvent.keyDown(tab, { key: "Enter" });
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "allow", "once");
    expect(onAnswered).toHaveBeenCalledTimes(1);
    cleanup();
    render(<PermissionCard permission={permission} canAnswer />);
    pickScope("始终");
    fireEvent.keyDown(screen.getByRole("tab", { name: "始终" }), {
      key: "Escape",
    });
    expect(api.answer).toHaveBeenLastCalledWith("n1-1-acp-t1", "deny", "never");
  });

  it("does not let Esc through to the prompt (it would stop the turn)", () => {
    const outer = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={outer}>
        <PermissionCard permission={permission} canAnswer />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /^允许/ }), {
      key: "Escape",
    });
    expect(outer).not.toHaveBeenCalled();
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
    expect(document.activeElement?.textContent).toBe("允许↵");
    fireEvent.click(screen.getByRole("button", { name: /^允许/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /^拒绝/ }));
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
    // 没有答复权限时 Esc 也不答。
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("expands the diff and the input behind the details before answering", () => {
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
    // 文件在「将发生」行里一直可见，差异与入参在详情里。
    expect(screen.getByText("a.ts:3")).toBeTruthy();
    expect(screen.queryByText("/elsewhere/a.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("/elsewhere/a.ts")).toBeTruthy();
    expect(screen.getByText(/"content": "new"/)).toBeTruthy();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("puts focus on the allow button when pinned, unless someone is typing", () => {
    render(<PermissionCard permission={permission} canAnswer pinned />);
    expect(document.activeElement?.textContent).toBe("允许↵");
    cleanup();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    render(<PermissionCard permission={permission} canAnswer pinned />);
    expect(document.activeElement).toBe(field);
    field.remove();
  });
});
