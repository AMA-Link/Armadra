import { describe, expect, it } from "vitest";

import { failureKey } from "./model";
import { GithubApiError } from "../../api/github";

describe("failures", () => {
  it("names the repair for each client failure", () => {
    expect(failureKey(new GithubApiError("conflict"))).toBe(
      "github.error.conflict",
    );
    expect(failureKey(new Error("boom"))).toBe("github.error.network");
  });

  it("never tells the user to just retry a write whose result is unknown", () => {
    expect(failureKey(new GithubApiError("network", true))).toBe(
      "github.error.unknownOutcome",
    );
  });
});
