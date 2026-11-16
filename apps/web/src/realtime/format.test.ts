import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { REALTIME_MESSAGE } from "@armadra/shared";

import type { SocketLike } from "./client";
import { BOARD_FORMAT, checkFormat, FORMAT_KEY, stampFormat } from "./format";
import { metaOf, nodesOf } from "./doc";
import { realtimeActive, startRealtime, stopRealtime } from "./session";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast }));

describe("checkFormat", () => {
  it("记着同一格式放行，不一样拒绝", () => {
    const doc = new Y.Doc();
    metaOf(doc).set(FORMAT_KEY, BOARD_FORMAT);
    expect(checkFormat(doc)).toBe("ok");
    expect(checkFormat(doc, BOARD_FORMAT + 1)).toBe("mismatch");
    metaOf(doc).set(FORMAT_KEY, "bad");
    expect(checkFormat(doc)).toBe("mismatch");
  });

  it("没记过：空文档谁先来谁落号；有内容的按旧格式比", () => {
    const doc = new Y.Doc();
    expect(checkFormat(doc)).toBe("stamp");
    expect(checkFormat(doc, 3)).toBe("stamp");
    nodesOf(doc).set("n", new Y.Map());
    expect(checkFormat(doc)).toBe("mismatch");
    expect(checkFormat(doc, 2)).toBe("stamp");
  });

  it("落号写进 meta", () => {
    const doc = new Y.Doc();
    stampFormat(doc);
    expect(metaOf(doc).get(FORMAT_KEY)).toBe(BOARD_FORMAT);
  });
});

/** 一个会答 step1 的假 core：把 `server` 的状态当 step2 送回去。 */
function coreSocket(server: Y.Doc, sent: Uint8Array[]) {
  return (): SocketLike => {
    const socket: SocketLike = {
      binaryType: "arraybuffer",
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data) {
        sent.push(data);
        const decoder = decoding.createDecoder(data);
        if (decoding.readVarUint(decoder) !== REALTIME_MESSAGE.sync) return;
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, REALTIME_MESSAGE.sync);
        syncProtocol.readSyncMessage(decoder, reply, server, "client");
        if (encoding.length(reply) > 1) {
          const bytes = encoding.toUint8Array(reply);
          queueMicrotask(() => socket.onmessage?.({ data: bytes }));
        }
      },
      close: () => undefined,
    };
    queueMicrotask(() => socket.onopen?.({}));
    return socket;
  };
}

describe("加入实时板的格式闸", () => {
  beforeEach(() => toast.error.mockClear());
  afterEach(() => stopRealtime("b1"));

  const join = async (server: Y.Doc) => {
    const sent: Uint8Array[] = [];
    startRealtime({
      workspaceId: "w1",
      boardId: "b1",
      createSocket: coreSocket(server, sent),
    });
    await vi.waitFor(() => {
      if (realtimeActive("b1") && toast.error.mock.calls.length === 0) {
        // 同步完成之前两种结果都还没出现。
        expect(sent.length).toBeGreaterThan(0);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  it("格式一致：留在实时，并给没记过格式的空板落号", async () => {
    const server = new Y.Doc();
    await join(server);
    expect(realtimeActive("b1")).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    expect(metaOf(server).get(FORMAT_KEY)).toBe(BOARD_FORMAT);
  });

  it("文档是别的格式：退出实时、提示一次、不往里写", async () => {
    const server = new Y.Doc();
    metaOf(server).set(FORMAT_KEY, BOARD_FORMAT + 1);
    await join(server);
    expect(realtimeActive("b1")).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(metaOf(server).get(FORMAT_KEY)).toBe(BOARD_FORMAT + 1);
  });
});
