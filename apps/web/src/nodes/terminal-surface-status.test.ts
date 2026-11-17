import { describe, expect, it } from "vitest";

import type { TerminalSurfaceStatus } from "@/terminal/surface/types";
import { nextSurfaceStatus } from "./terminal-surface-status";

const base: TerminalSurfaceStatus = {
  connection: "live",
  exitCode: null,
  error: null,
  binding: { sessionId: "s1", generation: 1 },
  render: "visible",
};

describe("nextSurfaceStatus", () => {
  it("视口与渲染名额的切换不换对象", () => {
    for (const render of ["offscreen", "focused", "detached"] as const) {
      expect(nextSurfaceStatus(base, { ...base, render })).toBe(base);
    }
    expect(
      nextSurfaceStatus(base, {
        ...base,
        binding: { sessionId: "s1", generation: 1 },
      }),
    ).toBe(base);
  });

  it("节点头看得见的变化换成新对象", () => {
    const cases: TerminalSurfaceStatus[] = [
      { ...base, render: "hibernated" },
      { ...base, render: "disconnected" },
      { ...base, connection: "exited", exitCode: 1 },
      { ...base, error: "boom" },
      { ...base, binding: { sessionId: "s1", generation: 2 } },
      { ...base, binding: null },
      { ...base, hibernation: "resuming" },
      { ...base, launch: "failed" },
    ];
    for (const next of cases) expect(nextSurfaceStatus(base, next)).toBe(next);
  });
});
