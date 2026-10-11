import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@armadra/shared";

import { useCanvasStore } from "../store/canvas-store";
import type { SourceConnection } from "./connection";
import { followWorkspaceSource } from "./follow-workspace";
import { type SourceRegistry, createSourceRegistry } from "./registry";
import type { SourceDescriptor, SourceStatus } from "./types";

/** 当前源由打开的工作空间推出：打开谁就是谁，关掉回本机，源晚到也跟上。 */

const descriptor = (sourceId: string): SourceDescriptor => ({
  sourceId,
  kind: "direct",
  label: sourceId,
  baseUrl: `https://${sourceId}.test`,
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex: 1,
});

function connection(d: SourceDescriptor): SourceConnection {
  const status: SourceStatus = {
    state: "ready",
    via: "direct",
    since: 1,
    lastError: null,
  };
  return {
    descriptor: d,
    status,
    subscribe: () => () => undefined,
    source: { sourceId: d.sourceId } as SourceConnection["source"],
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    disconnect: () => undefined,
    renew: async () => undefined,
    revoke: () => undefined,
  };
}

const workspace = (id: string) => ({ id, name: id }) as Workspace;
const current = (registry: SourceRegistry) =>
  registry.current().descriptor.sourceId;

let registry: SourceRegistry;
let stop: () => void;
beforeEach(() => {
  useCanvasStore.getState().setWorkspace(null);
  // 页面那张（接到 `api/source`）：省略源的打开取的是当前源。
  registry = createSourceRegistry({ connect: connection, global: true });
  registry.add(descriptor("far"));
  stop = followWorkspaceSource(registry);
});
afterEach(() => {
  stop();
  registry.dispose();
  useCanvasStore.getState().setWorkspace(null);
});

describe("当前源跟着打开的工作空间", () => {
  it("打开别的电脑上的工作空间：当前源换过去；关掉回到本机", () => {
    expect(current(registry)).toBe("local");
    useCanvasStore.getState().setWorkspace(workspace("w1"), "far");
    expect(current(registry)).toBe("far");
    useCanvasStore.getState().setWorkspace(null);
    expect(useCanvasStore.getState().sourceId).toBe("local");
    expect(current(registry)).toBe("local");
  });

  it("同一个源里换工作空间不动当前源", () => {
    useCanvasStore.getState().setWorkspace(workspace("w1"), "far");
    useCanvasStore.getState().setWorkspace(workspace("w2"));
    expect(useCanvasStore.getState().sourceId).toBe("far");
    expect(current(registry)).toBe("far");
  });

  it("工作空间的源还没进源表：先留在本机，源一到就跟过去", () => {
    useCanvasStore.getState().setWorkspace(workspace("w1"), "late");
    expect(current(registry)).toBe("local");
    registry.add(descriptor("late"));
    expect(current(registry)).toBe("late");
  });

  it("源被移走：退回本机；停掉之后不再跟", () => {
    useCanvasStore.getState().setWorkspace(workspace("w1"), "far");
    registry.remove("far");
    expect(current(registry)).toBe("local");
    stop();
    registry.add(descriptor("other"));
    useCanvasStore.getState().setWorkspace(workspace("w2"), "other");
    expect(current(registry)).toBe("local");
  });
});
