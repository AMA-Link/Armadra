import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./tool.js";

afterEach(() => vi.restoreAllMocks());

describe("armadra-hook tool", () => {
  it("refuses an unknown tool name and a missing one", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await run(["nope"])).toBe(1);
    expect(await run([])).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("known tool name");
  });
});
