import { describe, expect, it } from "vitest";
import { liveAgentSettings } from "./custom-agents";
import { normalize } from "./schema";

/** `agents.<id>.bareLaunch`（契约 §113，#975）的清洗与读取。 */

describe("agents.<id>.bareLaunch", () => {
  it("is read live from the document and defaults to off", () => {
    let document: Record<string, unknown> = {};
    const live = liveAgentSettings(() => document as never);
    expect(live.bareLaunch("claude")).toBe(false);
    document = { agents: { claude: { bareLaunch: true } } };
    expect(live.bareLaunch("claude")).toBe(true);
    expect(live.bareLaunch("codex")).toBe(false);
  });

  it("only applies to injected built-in agents", () => {
    const live = liveAgentSettings(
      () => ({ agents: { "custom:x": { bareLaunch: true } } }) as never,
    );
    expect(live.bareLaunch("custom:x")).toBe(false);
  });

  it("drops a value that is not a boolean and keeps a boolean", () => {
    const normalized = normalize({
      agents: {
        claude: { bareLaunch: true },
        codex: { bareLaunch: "yes" },
        opencode: { bareLaunch: false },
      },
    });
    const agents = normalized.agents as Record<string, Record<string, unknown>>;
    expect(agents.claude).toEqual({ bareLaunch: true });
    expect(agents.codex).toEqual({});
    expect(agents.opencode).toEqual({ bareLaunch: false });
  });

  it("does not grow a section for a document that never had one", () => {
    expect("agents" in normalize({})).toBe(false);
  });
});
