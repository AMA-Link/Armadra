import {
  AGENT_IDS as SHARED_AGENT_IDS,
  AGENT_LIST as SHARED_AGENT_LIST,
  injectedAgentIds,
} from "@armadra/shared";
import { describe, expect, it } from "vitest";

import { HOOKS_CAPABLE, SUBAGENT_CAPABLE } from "../hook/capabilities";
import { INJECTED_AGENTS } from "../hook/install/inject";
import { launchProfile } from "./launch";
import { AGENT_IDS, AGENT_REGISTRY, definition } from "./registry";

/**
 * The core restates the registry rather than importing it (the hook surface
 * must keep answering when the front end's package is not in the build), so
 * everything the core repeats is held to `@armadra/shared` here, derived from
 * `AGENT_IDS` rather than from a list of names. A built-in added to one side
 * and not the other fails here, once, in one place.
 */
describe("the core's registry mirror agrees with @armadra/shared", () => {
  it("has the same agents in the same order", () => {
    expect([...AGENT_IDS]).toEqual([...SHARED_AGENT_IDS]);
    expect(AGENT_REGISTRY.map((agent) => agent.id)).toEqual([
      ...SHARED_AGENT_IDS,
    ]);
  });

  it("agrees per agent on what the core reads from the row", () => {
    for (const shared of SHARED_AGENT_LIST) {
      const core = definition(shared.id);
      expect(core, shared.id).toBeDefined();
      expect(core?.label, shared.id).toBe(shared.label);
      expect(core?.launchCmd, shared.id).toBe(shared.launchCmd);
      expect(core?.promptMode, shared.id).toBe(shared.promptMode);
      expect([...(core?.expectedProcess ?? [])], shared.id).toEqual([
        ...shared.expectedProcess,
      ]);
      expect([...(core?.capabilities ?? [])].sort(), shared.id).toEqual(
        [...shared.capabilities].sort(),
      );
    }
  });

  it("repeats the launch table: flags, model, resume, quit command", () => {
    for (const shared of SHARED_AGENT_LIST) {
      const profile = launchProfile(shared.id);
      expect(profile, shared.id).toBeDefined();
      expect(profile?.permissionFlag, shared.id).toEqual(shared.permissionFlag);
      expect(profile?.modelFlag, shared.id).toBe(shared.modelFlag);
      expect(profile?.resume, shared.id).toEqual(shared.resume);
      expect(profile?.exitCommand, shared.id).toBe(shared.exitCommand);
      expect(profile?.sessionIdFlag, shared.id).toBe(shared.sessionIdFlag);
    }
  });

  it("derives the hook and subagent tables from the capabilities", () => {
    const having = (capability: string) =>
      SHARED_AGENT_LIST.filter((agent) =>
        (agent.capabilities as readonly string[]).includes(capability),
      ).map((agent) => agent.id);
    expect([...HOOKS_CAPABLE]).toEqual(having("hooks"));
    expect([...SUBAGENT_CAPABLE]).toEqual(having("subagent"));
  });

  it("injects exactly the built-ins that have an injection (§120)", () => {
    expect([...INJECTED_AGENTS]).toEqual([...injectedAgentIds()]);
  });
});
