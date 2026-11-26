import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";

const api = vi.hoisted(() => ({ loadBoard: vi.fn(), saveBoard: vi.fn() }));
vi.mock("@/api/client", () => ({
  runtimeApi: api,
  errorCode: (error: unknown) =>
    (error as { code?: string } | null)?.code ?? undefined,
}));

import { writeNodeOnBoard } from "./off-canvas-writer";

const node = { id: "n1", title: "Old" } as unknown as CanvasNode;
const document = (title: string) =>
  ({
    board: { id: "b1", updatedAt: "v1" },
    nodes: [{ ...node, title }],
    edges: [],
  }) as never;

beforeEach(() => {
  api.loadBoard.mockReset().mockResolvedValue(document("Old"));
  api.saveBoard.mockReset().mockResolvedValue(document("New"));
});

describe("writeNodeOnBoard (#1071)", () => {
  it("loads the board, changes that one node and saves with the version it read", async () => {
    await writeNodeOnBoard("w1", "b1", "n1", (current) => ({
      ...current,
      title: "New",
    }));
    expect(api.loadBoard).toHaveBeenCalledWith("w1", "b1");
    const saved = api.saveBoard.mock.calls[0]?.[2] as {
      nodes: CanvasNode[];
      board: { updatedAt: string };
    };
    expect(saved.board.updatedAt).toBe("v1");
    expect(saved.nodes[0]?.title).toBe("New");
  });

  it("does not save when the mutation declines or the node is gone", async () => {
    await writeNodeOnBoard("w1", "b1", "n1", () => null);
    await writeNodeOnBoard("w1", "b1", "missing", (current) => current);
    expect(api.saveBoard).not.toHaveBeenCalled();
  });

  it("reads again on a conflict, and gives up after three tries", async () => {
    api.saveBoard
      .mockReset()
      .mockRejectedValueOnce({ code: "conflict" })
      .mockResolvedValue(document("New"));
    await writeNodeOnBoard("w1", "b1", "n1", (current) => current);
    expect(api.loadBoard).toHaveBeenCalledTimes(2);

    api.saveBoard.mockReset().mockRejectedValue({ code: "conflict" });
    await expect(
      writeNodeOnBoard("w1", "b1", "n1", (current) => current),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
