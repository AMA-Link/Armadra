import { afterEach, describe, expect, it, vi } from "vitest";

import { openMeStream } from "./stream";

const LAPTOP = "00000000000000000000000000000006";

/** 一个可操纵的 WebSocket 替身。 */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
}

describe("openMeStream", () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.all = [];
  });

  const open = () => {
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const ticket = vi.fn(async () => ({ ticket: "tk" }));
    const stop = openMeStream(
      {
        origin: "https://app.example.test",
        ticket,
        createSocket: (url, protocols) =>
          new FakeSocket(url, protocols) as unknown as WebSocket,
      },
      { onEvent, onResync },
    );
    return { onEvent, onResync, ticket, stop };
  };

  it("用票据子协议连 /v1/me/stream，收事件、忽略不认识的类型，每 30 秒 ping", async () => {
    vi.useFakeTimers();
    const { onEvent, onResync, stop } = open();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.all[0]!;
    expect(socket.url).toBe("wss://app.example.test/v1/me/stream");
    expect(socket.protocols).toEqual(["armadra-ticket.tk"]);
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({ type: "sourceRevoked", sourceId: LAPTOP }),
    });
    socket.onmessage?.({ data: JSON.stringify({ type: "somethingNew" }) });
    socket.onmessage?.({ data: "not json" });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      type: "sourceRevoked",
      sourceId: LAPTOP,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toEqual([JSON.stringify({ type: "ping" })]);
    expect(onResync).not.toHaveBeenCalled();
    stop();
  });

  it("断线后退避重连，重连成功给 onResync；退订后不再重连", async () => {
    vi.useFakeTimers();
    const { onResync, ticket, stop } = open();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.onopen?.();
    FakeSocket.all[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.onopen?.();
    expect(onResync).toHaveBeenCalledOnce();
    expect(ticket).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("取票失败也重试", async () => {
    vi.useFakeTimers();
    const ticket = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ticket: "tk" });
    const stop = openMeStream(
      {
        origin: "http://localhost:3000",
        ticket,
        createSocket: (url, protocols) =>
          new FakeSocket(url, protocols) as unknown as WebSocket,
      },
      { onEvent: vi.fn(), onResync: vi.fn() },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all[0]!.url).toBe("ws://localhost:3000/v1/me/stream");
    stop();
  });
});
