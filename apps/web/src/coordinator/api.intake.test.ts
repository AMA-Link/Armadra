import { beforeEach, describe, expect, it, vi } from "vitest";

const procedures = vi.hoisted(() => ({
  sources: vi.fn(),
  intake: vi.fn(),
  saveSource: vi.fn(),
}));
vi.mock("@/api/client", async (original) => ({
  ...(await original<typeof import("@/api/client")>()),
  clientFor: () => ({ coordinator: procedures }),
}));

const { coordinatorApi } = await import("./api");

/** 旧 core 没有来源与候选的 procedure：读当作空，写照常报错（契约 §104.7）。 */

const notFound = Object.assign(new Error("not found"), { code: "not_found" });

beforeEach(() => {
  for (const fn of Object.values(procedures)) fn.mockReset();
});

describe("coordinatorApi 来源与候选", () => {
  it("reads sources and candidates as empty from a core without the procedures", async () => {
    procedures.sources.mockRejectedValue(notFound);
    procedures.intake.mockRejectedValue(notFound);
    expect(await coordinatorApi.sources("b1")).toEqual([]);
    expect(
      await coordinatorApi.intake("b1", { decided: false, offset: 0 }),
    ).toEqual({ candidates: [], total: 0, next: null });
  });

  it("lets other failures through", async () => {
    procedures.sources.mockRejectedValue(
      Object.assign(new Error("boom"), { code: "internal" }),
    );
    await expect(coordinatorApi.sources("b1")).rejects.toThrow("boom");
  });

  it("does not swallow a refused write", async () => {
    procedures.saveSource.mockRejectedValue(notFound);
    await expect(
      coordinatorApi.saveSource({
        coordinatorNodeId: "n",
        repo: "r",
        kinds: ["issue"],
        mode: "observe",
        allow: [],
        enabled: true,
      }),
    ).rejects.toThrow("not found");
  });

  it("asks for a page of 20 with the decided filter", async () => {
    procedures.intake.mockResolvedValue({
      candidates: [],
      total: 0,
      next: null,
    });
    await coordinatorApi.intake("b1", { decided: true, offset: 40 });
    expect(procedures.intake).toHaveBeenCalledWith({
      boardId: "b1",
      decided: true,
      offset: 40,
      limit: 20,
    });
  });
});
