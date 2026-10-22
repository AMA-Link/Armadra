import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ApprovalActions,
  ApprovalCommand,
  AwaitingDriver,
  COMMAND_LINES,
  HeaderApproval,
} from "./ApprovalShell";

afterEach(cleanup);

describe("HeaderApproval", () => {
  it("answers allow and deny, with the same words as the card", () => {
    const onAnswer = vi.fn();
    render(<HeaderApproval onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onAnswer.mock.calls).toEqual([["allow"], ["deny"]]);
  });

  it("keeps the label in the foreground colour and hides the tinted icons", () => {
    render(<HeaderApproval onAnswer={vi.fn()} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).not.toMatch(/text-\[var\(--(success|danger)/);
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
    }
  });
});

describe("ApprovalActions", () => {
  it("draws only the end group when there is no leading action", () => {
    render(<ApprovalActions trailing={<button type="button">拒绝</button>} />);
    expect(
      document.querySelectorAll("[data-slot=approval-actions] > div"),
    ).toHaveLength(1);
  });
});

describe("ApprovalCommand", () => {
  it("clamps a multi-line command and expands it", () => {
    const lines = Array.from({ length: COMMAND_LINES + 2 }, (_, i) => `l${i}`);
    render(<ApprovalCommand>{lines.join("\n")}</ApprovalCommand>);
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("AwaitingDriver", () => {
  it("is a quiet outline badge", () => {
    render(<AwaitingDriver />);
    expect(screen.getByText("等待接管").dataset.variant).toBe("outline");
  });
});
