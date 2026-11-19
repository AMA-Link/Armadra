import { describe, expect, it } from "vitest";

import {
  PRESET_NODE_NAMES,
  isPresetTitle,
  presetNodeName,
} from "./node-names.js";

describe("presetNodeName", () => {
  it("hands out the first word on an empty board", () => {
    expect(presetNodeName([])).toEqual({ title: "Atlas", handle: "atlas" });
  });

  it("skips words taken by a title or a handle, case-folded", () => {
    const nodes = [
      { title: "atlas", data: {} },
      { title: "Review", data: { handle: "Birch" } },
    ];
    expect(presetNodeName(nodes)).toEqual({ title: "Cedar", handle: "cedar" });
  });

  it("respects names reserved earlier in the same batch", () => {
    expect(presetNodeName([], ["atlas", "birch"]).handle).toBe("cedar");
  });

  it("fills the lowest gap so names are predictable", () => {
    const nodes = [
      { title: "Atlas", data: { handle: "atlas" } },
      { title: "Cedar", data: { handle: "cedar" } },
    ];
    expect(presetNodeName(nodes).handle).toBe("birch");
  });

  it("numbers the second round once the pool is used up", () => {
    const nodes = PRESET_NODE_NAMES.map((word) => ({
      title: word,
      data: { handle: word.toLowerCase() },
    }));
    expect(presetNodeName(nodes)).toEqual({
      title: "Atlas 2",
      handle: "atlas-2",
    });
  });

  it("only produces valid handles", () => {
    for (const word of PRESET_NODE_NAMES) {
      expect(word.toLowerCase()).toMatch(/^[a-z0-9][a-z0-9_-]{0,23}$/);
    }
    expect(new Set(PRESET_NODE_NAMES.map((w) => w.toLowerCase())).size).toBe(
      PRESET_NODE_NAMES.length,
    );
  });
});

describe("isPresetTitle", () => {
  it("recognises an untouched preset title", () => {
    expect(isPresetTitle("Atlas", "atlas")).toBe(true);
    expect(isPresetTitle("Atlas 2", "atlas-2")).toBe(true);
  });

  it("rejects renamed titles, foreign handles and missing handles", () => {
    expect(isPresetTitle("Fix the API", "atlas")).toBe(false);
    expect(isPresetTitle("Atlas", "birch")).toBe(false);
    expect(isPresetTitle("Reviewer", "reviewer")).toBe(false);
    expect(isPresetTitle("Atlas", undefined)).toBe(false);
    expect(isPresetTitle("Atlas 1", "atlas-1")).toBe(false);
  });
});
