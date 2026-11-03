import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const fetchSettings = vi.fn();
const patchSettings = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: {
    settings: () => fetchSettings(),
    updateSettings: (patch: unknown) => patchSettings(patch),
  },
}));

import { installDomPolyfills, TestProviders } from "./test-harness";
import { usePreferencesStore } from "./preferences-store";
import { useAgentModesMirror } from "./use-agent-modes-mirror";

installDomPolyfills();
afterEach(cleanup);

function Harness() {
  useAgentModesMirror();
  return null;
}

function draw() {
  render(
    <TestProviders>
      <Harness />
    </TestProviders>,
  );
}

/** 关掉的 Agent 抄一份给 core 的 `agents.disabled`（契约 §97），只在不一致时写。 */
describe("useAgentModesMirror", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchSettings.mockReset();
    patchSettings
      .mockReset()
      .mockImplementation(
        async (patch: { agents: { disabled: string[] | null } }) => ({
          agents: { disabled: patch.agents.disabled ?? undefined },
        }),
      );
    usePreferencesStore.setState({ agentModes: {} });
  });

  it("writes the disabled ones when the core has none, then follows a switch", async () => {
    usePreferencesStore.setState({
      agentModes: { codex: "disabled", claude: "enabled", pi: "disabled" },
    });
    fetchSettings.mockResolvedValue({});
    draw();
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        agents: { disabled: ["codex", "pi"] },
      }),
    );
    act(() =>
      usePreferencesStore.getState().setAgentMode("claude", "disabled"),
    );
    await waitFor(() =>
      expect(patchSettings).toHaveBeenLastCalledWith({
        agents: { disabled: ["claude", "codex", "pi"] },
      }),
    );
  });

  it("clears the key when everything is switched back on", async () => {
    usePreferencesStore.setState({ agentModes: {} });
    fetchSettings.mockResolvedValue({ agents: { disabled: ["codex"] } });
    draw();
    await waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({
        agents: { disabled: null },
      }),
    );
  });

  it("writes nothing when the core already agrees", async () => {
    usePreferencesStore.setState({ agentModes: { pi: "disabled" } });
    fetchSettings.mockResolvedValue({ agents: { disabled: ["pi"] } });
    draw();
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 20));
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it("writes nothing for a user who never switched an agent off", async () => {
    fetchSettings.mockResolvedValue({});
    draw();
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 20));
    expect(patchSettings).not.toHaveBeenCalled();
  });
});
