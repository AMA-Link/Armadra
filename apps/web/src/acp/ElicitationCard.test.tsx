import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AcpElicitationForm } from "@armadra/shared";

const api = vi.hoisted(() => ({ answerElicitation: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

import { useAgentStatusStore } from "@/agent/status-store";
import {
  ElicitationCard,
  contentOf,
  initialValues,
  safeUrl,
} from "./ElicitationCard";
import { useAnsweredStore } from "./answered";
import type { AcpElicitationView } from "./approval-views";

const form: AcpElicitationForm = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name" },
    color: {
      type: "string",
      title: "Color",
      enum: ["red", "blue"],
      enumNames: ["Red", "Blue"],
      default: "red",
    },
    count: { type: "integer", title: "Count", minimum: 1 },
    loud: { type: "boolean", title: "Loud" },
  },
  required: ["name"],
};

const view: AcpElicitationView = {
  pendingId: "n1-1-acp-e1",
  elicitation: { message: "Fill it in", mode: "form", requestedSchema: form },
};

beforeEach(() => {
  api.answerElicitation.mockReset().mockResolvedValue({});
  useAnsweredStore.getState().reset();
});

afterEach(cleanup);

describe("contentOf", () => {
  it("drops empty optional strings, converts numbers, keeps booleans", () => {
    const values = { ...initialValues(form), name: "ada", count: "3" };
    expect(contentOf(form, values)).toEqual({
      name: "ada",
      color: "red",
      count: 3,
      loud: false,
    });
    expect(contentOf(form, { ...values, count: "" })).toEqual({
      name: "ada",
      color: "red",
      loud: false,
    });
  });

  it("rejects a missing required field and broken constraints", () => {
    const values = initialValues(form);
    expect(contentOf(form, values)).toBeNull();
    expect(contentOf(form, { ...values, name: "a", count: "0" })).toBeNull();
    expect(contentOf(form, { ...values, name: "a", count: "1.5" })).toBeNull();
    expect(
      contentOf(form, { ...values, name: "a", color: "green" }),
    ).toBeNull();
  });
});

describe("safeUrl", () => {
  it("only lets http(s) through", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});

describe("ElicitationCard", () => {
  it("draws text, enum, number and boolean fields from the schema", () => {
    render(<ElicitationCard view={view} canAnswer />);
    expect(screen.getByText("Fill it in")).toBeTruthy();
    expect(screen.getByLabelText(/Name/).tagName).toBe("INPUT");
    expect(screen.getByRole("combobox").textContent).toContain("Red");
    expect((screen.getByLabelText(/Count/) as HTMLInputElement).type).toBe(
      "number",
    );
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("keeps submit disabled until the form is valid, then accepts once", async () => {
    const resolveApproval = vi.spyOn(
      useAgentStatusStore.getState(),
      "resolveApproval",
    );
    render(<ElicitationCard view={view} canAnswer />);
    const submit = screen.getByRole("button", {
      name: /^提交/,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "ada" },
    });
    fireEvent.click(screen.getByRole("switch"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("n1-1-acp-e1", {
        action: "accept",
        content: { name: "ada", color: "red", loud: true },
      }),
    );
    expect(api.answerElicitation).toHaveBeenCalledTimes(1);
    expect(useAnsweredStore.getState().ids.has("n1-1-acp-e1")).toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith("n1-1-acp-e1");
  });

  it("declines and cancels without content", async () => {
    render(<ElicitationCard view={view} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("n1-1-acp-e1", {
        action: "cancel",
      }),
    );
    cleanup();
    render(<ElicitationCard view={view} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenLastCalledWith("n1-1-acp-e1", {
        action: "decline",
      }),
    );
  });

  it("puts the card back when the answer is not taken", async () => {
    api.answerElicitation.mockRejectedValue(new Error("400"));
    render(<ElicitationCard view={view} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(api.answerElicitation).toHaveBeenCalled());
    await waitFor(() =>
      expect(useAnsweredStore.getState().ids.has("n1-1-acp-e1")).toBe(false),
    );
  });

  it("offers only decline and cancel when the form could not be kept", () => {
    render(
      <ElicitationCard
        view={{
          pendingId: "e2",
          elicitation: { message: "Nested", mode: "form" },
        }}
        canAnswer
      />,
    );
    expect(screen.queryByRole("button", { name: /^提交/ })).toBeNull();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("url mode shows a safe link and continues without content", async () => {
    render(
      <ElicitationCard
        view={{
          pendingId: "e3",
          elicitation: {
            message: "Authorize",
            mode: "url",
            url: "https://example.com/auth",
          },
        }}
        canAnswer
      />,
    );
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/auth");
    expect(link.rel).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: /^继续/ }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("e3", {
        action: "accept",
      }),
    );
  });

  it("names the card and the form by the message, with a hidden warning icon", () => {
    render(<ElicitationCard view={view} canAnswer />);
    const card = screen.getByRole("group", { name: "Fill it in" });
    expect(card.getAttribute("data-slot")).toBe("acp-elicitation");
    expect(card.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelector("form")?.getAttribute("aria-labelledby")).toBe(
      card.getAttribute("aria-labelledby"),
    );
  });

  it("cancel sits apart at the start, decline and the primary submit at the end", () => {
    render(<ElicitationCard view={view} canAnswer />);
    const [lead, tail] = document.querySelectorAll(
      "[data-slot=approval-actions] > div",
    ) as unknown as [HTMLElement, HTMLElement];
    expect(lead.textContent).toBe("取消");
    expect(
      [...tail.querySelectorAll("button")].map((button) => [
        button.textContent,
        button.dataset.variant,
      ]),
    ).toEqual([
      ["拒绝", "outline"],
      ["提交↵", "default"],
    ]);
  });

  it("marks a typed value that breaks the schema invalid, but not an untouched empty one", () => {
    render(<ElicitationCard view={view} canAnswer />);
    const count = screen.getByLabelText(/Count/) as HTMLInputElement;
    expect(count.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(count, { target: { value: "0" } });
    expect(count.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(count, { target: { value: "2" } });
    expect(count.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps inputs at the default text size so touch screens do not zoom", () => {
    render(<ElicitationCard view={view} canAnswer />);
    const input = screen.getByLabelText(/Name/);
    expect(input.className).not.toMatch(/(^|\s)text-\[13px\]/);
  });

  it("hands focus back once an answer from inside the card is taken", async () => {
    const onAnswered = vi.fn();
    render(<ElicitationCard view={view} canAnswer onAnswered={onAnswered} />);
    const cancel = screen.getByRole("button", { name: "取消" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(onAnswered).toHaveBeenCalledTimes(1));
  });

  it("shows only the message to someone who cannot answer", () => {
    render(<ElicitationCard view={view} canAnswer={false} />);
    expect(screen.getByText("Fill it in")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("等待接管")).toBeTruthy();
  });
});
