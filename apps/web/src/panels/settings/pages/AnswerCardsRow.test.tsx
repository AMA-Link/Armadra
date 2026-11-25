import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../../../app/preferences-store";

const runtime = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ runtimeApi: {} }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: runtime.data },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { AnswerCardsRow } from "./AgentDetailPage";

installDomPolyfills();

function draw(id: string, label: string) {
  render(
    <TestProviders>
      <AnswerCardsRow agent={{ id, label }} />
    </TestProviders>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  runtime.data = { agents: {} };
  runtime.mutate.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("设置 → grok 终端审批代答开关（契约 §127）", () => {
  it("默认关；打开写 agents.grok.answerCards", () => {
    draw("grok", "Grok Build");
    const toggle = screen.getByRole("switch", {
      name: "Grok Build 终端审批代答",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(runtime.mutate).toHaveBeenCalledWith({
      agents: { grok: { answerCards: true } },
    });
  });

  it("设置里是开就显示开，再点写回 false", () => {
    runtime.data = { agents: { grok: { answerCards: true } } };
    draw("grok", "Grok Build");
    const toggle = screen.getByRole("switch", {
      name: "Grok Build 终端审批代答",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(runtime.mutate).toHaveBeenCalledWith({
      agents: { grok: { answerCards: false } },
    });
  });

  it("别家没有这一行", () => {
    draw("claude", "Claude Code");
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
