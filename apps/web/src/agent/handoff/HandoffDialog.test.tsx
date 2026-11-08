import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { BoardDocument } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { HandoffDialog, canWithdraw, isSettled } from "./HandoffDialog";
import { setAgentRegistry } from "@/agent/launch";
import { handoffTargets, openHandoff } from "./handoff-targets";

const api = vi.hoisted(() => ({
  prepareHandoff: vi.fn(),
  acceptHandoff: vi.fn(),
  cancelHandoff: vi.fn(),
  handoff: vi.fn(),
  sessions: vi.fn(),
  getTerminal: vi.fn(),
}));
vi.mock("@/api/client", () => ({ runtimeApi: api }));
vi.mock("@/app/use-agents", () => ({
  useEnabledAgents: () => [
    { id: "codex", label: "Codex", baseAgent: "codex", installed: true },
    { id: "pi", label: "Pi", baseAgent: "pi", installed: true },
  ],
}));
vi.mock("@/agent/models", () => ({
  useAgentModels: () => ({
    models: [{ id: "gpt-5", label: "gpt-5", source: "cli" }],
    loading: false,
  }),
}));
vi.mock("@/api/events", () => ({ onWorkspaceEvent: () => () => undefined }));
vi.mock("@/ui/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const TARGET_SESSION = "33333333-3333-4333-8333-333333333333";

function terminalNode(id: string, title: string, agent: string | null) {
  return {
    id,
    boardId: "b",
    type: "terminal",
    title,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    data: {
      kind: "terminal",
      cwd: ".",
      ...(agent ? { agent: { id: agent } } : {}),
    },
  } as unknown as BoardDocument["nodes"][number];
}

function document(): BoardDocument {
  return {
    board: { id: "b" },
    nodes: [
      terminalNode(SOURCE, "Source", "claude"),
      terminalNode(TARGET, "Reviewer", "codex"),
      terminalNode("44444444-4444-4444-8444-444444444444", "Plain", null),
    ],
    edges: [
      { id: "e1", boardId: "b", source: SOURCE, target: TARGET, kind: "link" },
      {
        id: "e2",
        boardId: "b",
        source: SOURCE,
        target: "44444444-4444-4444-8444-444444444444",
        kind: "link",
      },
    ],
  } as unknown as BoardDocument;
}

function view(state: string, extra: Record<string, unknown> = {}) {
  return {
    bundle: {
      version: 1,
      handoffId: "55555555-5555-4555-8555-555555555555",
      workspaceId: "w",
      createdAt: "2026-09-05T00:00:00Z",
      source: { nodeId: SOURCE, agentId: "claude", modelId: null },
      target: {
        nodeId: TARGET,
        agentId: "codex",
        modelId: null,
        workingDirectory: "/tmp/project",
      },
      cutoff: { kind: "unavailable" },
      sections: { goal: "Continue" },
      transcriptExcerpt: "",
      trust: "peerDataNotSystemInstructions",
      sourcePreserved: true,
      files: [{ path: "src/api.rs", status: "referenced" }],
      git: { status: "unavailable", headOid: null },
      attachments: [],
      budget: {
        byteLimit: 8192,
        usedBytes: 1845,
        truncated: false,
        omitted: ["tokenBudgetUnavailable"],
      },
    },
    digest: "digest-of-the-preview",
    state,
    mailboxId: null,
    traceId: null,
    errorCode: null,
    acceptedAt: null,
    updatedAt: "2026-09-05T00:00:00Z",
    sourceHasNewActivity: false,
    ...extra,
  };
}

/** Radix 的 Select 要先用键盘打开才会渲染选项；jsdom 里没有真实指针。 */
async function chooseTarget(name: string) {
  const trigger = screen.getByRole("combobox", { name: "Target agent" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({
    workspace: { id: "w" },
    document: document(),
  } as never);
  for (const call of Object.values(api)) call.mockReset();
  api.sessions.mockResolvedValue([
    { nodeId: TARGET, sessionId: TARGET_SESSION },
  ]);
  api.getTerminal.mockResolvedValue({
    status: "running",
    generation: 4,
  });
  api.handoff.mockImplementation(() => new Promise(() => undefined));
});
afterEach(cleanup);

describe("handoff targets", () => {
  it("offers only linked agent terminals, never a plain terminal or itself", () => {
    expect(handoffTargets(document(), SOURCE)).toEqual([
      { nodeId: TARGET, title: "Reviewer", agentId: "codex" },
    ]);
    expect(handoffTargets(document(), TARGET)).toEqual([
      { nodeId: SOURCE, title: "Source", agentId: "claude" },
    ]);
  });

  it("offers a linked ACP node, and never an agent in an SSH terminal", () => {
    const acp = "66666666-6666-4666-8666-666666666666";
    const remote = "77777777-7777-4777-8777-777777777777";
    const node = (
      id: string,
      title: string,
      extra: Record<string, unknown>,
    ) => {
      const base = terminalNode(id, title, "codex");
      return {
        ...base,
        data: { ...base.data, ...extra },
      } as unknown as BoardDocument["nodes"][number];
    };
    const doc = {
      board: { id: "b" },
      nodes: [
        terminalNode(SOURCE, "Source", "claude"),
        node(acp, "Session", { agent: { id: "codex", driver: "acp" } }),
        node(remote, "Remote", { ssh: { hostId: "h" } }),
      ],
      edges: [
        { id: "e1", boardId: "b", source: SOURCE, target: acp, kind: "link" },
        {
          id: "e2",
          boardId: "b",
          source: remote,
          target: SOURCE,
          kind: "link",
        },
      ],
    } as unknown as BoardDocument;
    expect(handoffTargets(doc, SOURCE)).toEqual([
      { nodeId: acp, title: "Session", agentId: "codex" },
    ]);
  });
});

describe("handoff dialog", () => {
  it("previews before anything is sent and only accepts the digest it showed", async () => {
    api.prepareHandoff.mockResolvedValue(view("prepared"));
    api.acceptHandoff.mockResolvedValue(view("queued"));
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    const goal = await screen.findByLabelText("Goal");
    fireEvent.change(goal, { target: { value: "Continue the review" } });
    fireEvent.change(screen.getByLabelText("Acceptance criteria"), {
      target: { value: "Tests pass" },
    });
    // The target picker is a Radix select; setting it through the DOM is not
    // what is under test, so the choice is made the same way the mutation
    // reads it: by node id.
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(api.prepareHandoff).toHaveBeenCalledTimes(1));
    const request = api.prepareHandoff.mock.calls[0]![1];
    expect(request.sections.acceptance).toBe("Tests pass");
    expect(request.target).toEqual({
      kind: "node",
      nodeId: TARGET,
      sessionId: TARGET_SESSION,
      // The target generation comes from the runtime, not from a stale guess.
      generation: 4,
    });
    expect(request.sourceGeneration).toBe(2);
    // Preparing must not have notified anyone.
    expect(api.acceptHandoff).not.toHaveBeenCalled();

    // The preview names what travels and what does not.
    expect(await screen.findByText(/src\/api\.rs/)).toBeTruthy();
    expect(screen.getByText("tokenBudgetUnavailable")).toBeTruthy();
    expect(screen.getByText("Git fingerprint unavailable")).toBeTruthy();
    expect(screen.getByText(/1845 \/ 8192 bytes/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm handoff" }));
    await waitFor(() => expect(api.acceptHandoff).toHaveBeenCalledTimes(1));
    expect(api.acceptHandoff).toHaveBeenCalledWith(
      "w",
      "55555555-5555-4555-8555-555555555555",
      "digest-of-the-preview",
    );
    expect(await screen.findByText("In the target's inbox")).toBeTruthy();
    // Approving puts the material in an inbox. It does not say the target has
    // seen it, and the dialog must not imply that it has.
    expect(
      screen.getByText(/Nothing was written into the target's terminal/),
    ).toBeTruthy();
  });

  it("withdraws the frozen bundle when the user goes back to editing", async () => {
    api.prepareHandoff.mockResolvedValue(view("prepared"));
    api.cancelHandoff.mockResolvedValue(view("cancelled"));
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Continue" },
    });
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Back to editing" });
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    await waitFor(() => expect(api.cancelHandoff).toHaveBeenCalledTimes(1));
    // Back at the form, and nothing was accepted along the way.
    expect(await screen.findByLabelText("Goal")).toBeTruthy();
    expect(api.acceptHandoff).not.toHaveBeenCalled();
  });

  it("reports an acknowledgement as the target's own act", async () => {
    api.prepareHandoff.mockResolvedValue(view("acknowledged"));
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Continue" },
    });
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("The target acknowledged it")).toBeTruthy();
    // Acknowledged is the target's word, and it ends the source's options:
    // there is nothing left to withdraw.
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });
});

describe("handoff dialog: a new agent as the target", () => {
  async function open() {
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Continue" },
    });
  }
  async function pick(label: string, option: string) {
    fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: option }));
  }

  beforeEach(() => {
    setAgentRegistry([
      { id: "codex", label: "Codex", acp: { program: "codex-acp" } },
      { id: "pi", label: "Pi" },
    ] as never);
  });

  it("offers the new-agent entry, and the four fields only once it is chosen", async () => {
    await open();
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
    await pick("Target agent", "New agent…");
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Permission mode" }),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Surface" })).toBeTruthy();
  });

  it("sends the spec without asking the runtime for a session, and shows it in the preview", async () => {
    api.prepareHandoff.mockResolvedValue(
      view("prepared", {
        bundle: {
          ...view("prepared").bundle,
          target: {
            nodeId: "",
            agentId: "codex",
            modelId: "gpt-5",
            workingDirectory: "/tmp/project",
          },
          targetSpec: {
            kind: "new",
            agentId: "codex",
            model: "gpt-5",
            surface: "acp",
          },
          budget: {
            byteLimit: 8192,
            usedBytes: 1845,
            truncated: false,
            omitted: [],
            capacityTokens: 400_000,
            availableTokens: 272_000,
            reservedTokens: 128_000,
            tokenEstimate: 615,
          },
        },
      }),
    );
    await open();
    await pick("Target agent", "New agent…");
    await pick("Model", "gpt-5");
    await pick("Surface", "ACP");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(api.prepareHandoff).toHaveBeenCalledTimes(1));
    expect(api.prepareHandoff.mock.calls[0]![1].target).toEqual({
      kind: "new",
      agentId: "codex",
      surface: "acp",
      model: "gpt-5",
    });
    expect(api.sessions).not.toHaveBeenCalled();
    // The preview names what will be opened and the model-sized budget.
    expect(
      await screen.findByText(/Opened on confirmation · ACP/),
    ).toBeTruthy();
    expect(screen.getByText(/272K tokens available/)).toBeTruthy();
    expect(screen.getByText(/capacity 400K/)).toBeTruthy();
  });

  it("offers ACP only for an agent that has an ACP entry, and resets the choices on a change", async () => {
    await open();
    await pick("Target agent", "New agent…");
    await pick("Surface", "ACP");
    await pick("Agent", "Pi");
    // Pi has no ACP entry: the surface is back to the terminal and has no ACP option.
    expect(screen.getByRole("combobox", { name: "Surface" }).textContent).toBe(
      "Terminal",
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Surface" }), {
      key: "ArrowDown",
    });
    expect(
      await screen.findByRole("option", { name: "Terminal" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: "ACP" })).toBeNull();
  });
});

describe("handoff state predicates", () => {
  it("allows withdrawal while the inbox entry is still unacknowledged", () => {
    expect(canWithdraw("prepared")).toBe(true);
    expect(canWithdraw("queued")).toBe(true);
    expect(canWithdraw("acknowledged")).toBe(false);
    expect(canWithdraw("cancelled")).toBe(false);
  });
  it("keeps polling until the target answers or the source withdraws", () => {
    // Only the target can move this on, and it does so out of band.
    expect(isSettled("prepared")).toBe(false);
    expect(isSettled("queued")).toBe(false);
    expect(isSettled("acknowledged")).toBe(true);
    expect(isSettled("cancelled")).toBe(true);
  });
});
