import { describe, expect, it } from "vitest";
import { permissionOf } from "../../../agent-host/ama/tools";
import { VERB_TOOLS } from "../../../hook-client/verbs";
import { OMP_HOOK_EVENTS, PI_HOOK_EVENTS } from "./events";
import { ompExtensionTools, piExtensionSource } from "./extension-template";

const CLIENT = "/opt/armadra/armadra-hook";

describe("omp in-process tools (contract §110)", () => {
  it("registers every VERB_TOOLS entry, by the same name and schema", () => {
    const tools = ompExtensionTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      VERB_TOOLS.map((tool) => tool.name),
    );
    for (const [index, tool] of tools.entries()) {
      expect(tool.parameters).toEqual(VERB_TOOLS[index]?.inputSchema);
    }
  });

  it("files each tool under the class ama files it under, never above exec", () => {
    const expected: Record<string, string> = {
      read: "read",
      write: "write",
      execute: "exec",
    };
    for (const [index, tool] of ompExtensionTools().entries()) {
      const verb = VERB_TOOLS[index];
      expect(verb).toBeDefined();
      if (verb === undefined) continue;
      expect(tool.approval).toBe(expected[permissionOf(verb)]);
    }
    const byName = new Map(
      ompExtensionTools().map((tool) => [tool.name, tool]),
    );
    // Board and context verbs run unasked in omp's write mode; stopping or
    // closing another agent and the browser's file transfers still ask.
    expect(byName.get("canvas_list")?.approval).toBe("read");
    expect(byName.get("canvas_send")?.approval).toBe("read");
    expect(byName.get("canvas_interrupt")?.approval).toBe("exec");
    expect(byName.get("browser_download")?.approval).toBe("exec");
  });

  it("emits the tools and the registration only for omp", () => {
    const omp = piExtensionSource(
      "omp",
      CLIENT,
      OMP_HOOK_EVENTS,
      ompExtensionTools(),
    );
    expect(omp).toContain("pi.registerTool(");
    expect(omp).toContain('"name":"canvas_list"');
    expect(omp).toContain('"approval":"read"');
    // The events are still forwarded.
    expect(omp).toContain("pi.on(name");
    const pi = piExtensionSource("pi", CLIENT, PI_HOOK_EVENTS);
    expect(pi).toContain("const ARMADRA_TOOLS = [];");
    // Deterministic.
    expect(
      piExtensionSource("omp", CLIENT, OMP_HOOK_EVENTS, ompExtensionTools()),
    ).toBe(omp);
  });
});
