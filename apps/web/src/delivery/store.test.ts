import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryChangedEvent, WorkspaceEvent } from "@armadra/shared";

import { deliveryApi } from "./api";
import { node, pull } from "./fixtures";
import { offBoardVisible, useDeliveryBoard } from "./store";
import { OFF_BOARD_KEEP_MS } from "./model";

function changed(
  patch: Partial<Omit<DeliveryChangedEvent, "type">> = {},
): WorkspaceEvent {
  return {
    type: "delivery.changed",
    boardId: "b1",
    nodeId: "n1",
    lane: "needsYou",
    phrase: "ciFailing",
    ...patch,
  };
}

let board: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useDeliveryBoard.getState().reset();
  board = vi
    .spyOn(deliveryApi, "board")
    .mockResolvedValue({ nodes: [node({ pulls: [pull()] })] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delivery store", () => {
  it("reads the route first", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    expect(board).toHaveBeenCalledTimes(1);
    const state = useDeliveryBoard.getState();
    expect(state.loaded).toBe(true);
    expect(state.rows.n1?.phrase).toBe("awaitingReview");
  });

  it("applies a frame to lane and phrase without re-reading", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    useDeliveryBoard.getState().handleEvent(changed());
    const row = useDeliveryBoard.getState().rows.n1;
    expect(row?.lane).toBe("needsYou");
    expect(row?.phrase).toBe("ciFailing");
    expect(row?.pulls).toHaveLength(1);
    expect(board).toHaveBeenCalledTimes(1);
  });

  it("re-reads when pullsChanged is set", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    useDeliveryBoard.getState().handleEvent(
      changed({
        lane: "inReview",
        phrase: "awaitingReview",
        pullsChanged: true,
      }),
    );
    await Promise.resolve();
    expect(board).toHaveBeenCalledTimes(2);
  });

  it("re-reads for a node it has not seen", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    useDeliveryBoard.getState().handleEvent(changed({ nodeId: "n2" }));
    expect(useDeliveryBoard.getState().rows.n2?.lane).toBe("needsYou");
    await Promise.resolve();
    expect(board).toHaveBeenCalledTimes(2);
  });

  it("ignores other boards, other frames and malformed payloads", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    const { handleEvent } = useDeliveryBoard.getState();
    handleEvent(changed({ boardId: "other" }));
    handleEvent({ type: "board.changed" } as unknown as WorkspaceEvent);
    expect(useDeliveryBoard.getState().rows.n1?.lane).toBe("inReview");
  });

  it("re-reads after a reconnect (second refresh keeps the board)", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    board.mockResolvedValueOnce({
      nodes: [node({ lane: "readyToMerge", phrase: "mergeable" })],
    });
    await useDeliveryBoard.getState().refresh("w1", "b1");
    expect(useDeliveryBoard.getState().rows.n1?.lane).toBe("readyToMerge");
  });

  it("keeps rows when a read fails", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    board.mockRejectedValueOnce(new Error("down"));
    await useDeliveryBoard.getState().refresh("w1", "b1");
    expect(useDeliveryBoard.getState().rows.n1).toBeDefined();
  });

  it("drops rows when the board changes", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    board.mockResolvedValueOnce({ nodes: [] });
    await useDeliveryBoard.getState().refresh("w1", "b2");
    expect(useDeliveryBoard.getState().rows).toEqual({});
  });

  it("keeps an off-board row for 24 hours, then hides it", async () => {
    board.mockResolvedValue({
      nodes: [
        node({
          lane: "offBoard",
          phrase: "merged",
          pulls: [pull({ state: "merged" })],
          endedAtMs: 10_000,
        }),
      ],
    });
    await useDeliveryBoard.getState().refresh("w1", "b1");
    const row = useDeliveryBoard.getState().rows.n1!;
    expect(row.offBoardAtMs).toBe(10_000);
    expect(offBoardVisible(row, 10_000 + OFF_BOARD_KEEP_MS - 1)).toBe(true);
    expect(offBoardVisible(row, 10_000 + OFF_BOARD_KEEP_MS)).toBe(false);
  });

  it("never shows an off-board row without endedAtMs", async () => {
    board.mockResolvedValue({
      nodes: [node({ lane: "offBoard", phrase: "closed" })],
    });
    await useDeliveryBoard.getState().refresh("w1", "b1");
    const row = useDeliveryBoard.getState().rows.n1!;
    expect(row.offBoardAtMs).toBeNull();
    expect(offBoardVisible(row, 0)).toBe(false);
  });

  it("a frame into off board re-reads the route for endedAtMs", async () => {
    await useDeliveryBoard.getState().refresh("w1", "b1");
    board.mockResolvedValueOnce({
      nodes: [node({ lane: "offBoard", phrase: "merged", endedAtMs: 5_000 })],
    });
    useDeliveryBoard
      .getState()
      .handleEvent(changed({ lane: "offBoard", phrase: "merged" }));
    await vi.waitFor(() =>
      expect(useDeliveryBoard.getState().rows.n1?.offBoardAtMs).toBe(5_000),
    );
  });

  it("a frame back onto the board clears the off-board time", async () => {
    board.mockResolvedValueOnce({
      nodes: [node({ lane: "offBoard", phrase: "merged", endedAtMs: 5_000 })],
    });
    await useDeliveryBoard.getState().refresh("w1", "b1");
    useDeliveryBoard
      .getState()
      .handleEvent(changed({ lane: "working", phrase: "working" }));
    expect(useDeliveryBoard.getState().rows.n1?.offBoardAtMs).toBeNull();
  });
});
