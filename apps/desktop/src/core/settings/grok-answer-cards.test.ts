import { describe, expect, it } from "vitest";
import { normalize } from "./schema";

/** `agents.grok.answerCards`（契约 §127）：非布尔丢掉键，缺省关。 */
describe("agents.grok.answerCards", () => {
  it("keeps a boolean and drops anything else", () => {
    const on = normalize({ agents: { grok: { answerCards: true } } });
    expect((on.agents as Record<string, unknown>).grok).toEqual({
      answerCards: true,
    });
    const bad = normalize({ agents: { grok: { answerCards: "yes" } } });
    expect((bad.agents as Record<string, unknown>).grok).toEqual({});
  });

  it("does not grow a section for a document that never had one", () => {
    expect("agents" in normalize({})).toBe(false);
  });
});
