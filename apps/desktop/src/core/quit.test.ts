import { describe, expect, it, vi } from "vitest";

import { QUIT_MESSAGE, isQuitMessage, sendQuitIntent } from "./quit";

describe("the quit intent message", () => {
  it("is recognised only in its exact shape", () => {
    expect(isQuitMessage({ type: QUIT_MESSAGE, reapSessions: true })).toBe(
      true,
    );
    expect(isQuitMessage({ type: QUIT_MESSAGE })).toBe(false);
    expect(isQuitMessage({ type: "armadra:identity-ticket", id: 1 })).toBe(
      false,
    );
    expect(isQuitMessage(null)).toBe(false);
  });

  it("is sent over the fork channel, and a closed channel is not an error", () => {
    const send = vi.fn(() => true);
    sendQuitIntent({ send, connected: true }, true);
    expect(send).toHaveBeenCalledWith({
      type: QUIT_MESSAGE,
      reapSessions: true,
    });
    const closed = vi.fn();
    sendQuitIntent({ send: closed, connected: false }, true);
    expect(closed).not.toHaveBeenCalled();
    expect(() =>
      sendQuitIntent(
        {
          send: () => {
            throw new Error("channel closed");
          },
        },
        false,
      ),
    ).not.toThrow();
    expect(() => sendQuitIntent({}, true)).not.toThrow();
  });
});
