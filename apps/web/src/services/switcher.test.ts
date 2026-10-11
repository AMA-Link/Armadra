import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStorage } from "../mobile/testing";
import { setActiveConnection } from "../mobile/connections";
import { pendingJoinOpen } from "../sources/join-intent";
import { createSourceRegistry, resetSourceRegistry } from "../sources/registry";
import { takeEnterIntent } from "./recent";
import { manageConnections, openSource } from "./switcher";

const SHARED = {
  sourceId: "shared-1",
  kind: "relayed" as const,
  label: "设计稿",
  baseUrl: "",
  relayOrigin: "https://relay.example.com",
  cloudIssuer: "https://relay.example.com",
  fingerprint: "",
  orderIndex: 0,
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => {
  resetSourceRegistry(null);
  vi.unstubAllGlobals();
});

describe("换连接不重载", () => {
  it("已挂着的同伴：只切当前源并打开它的工作空间，不重载", () => {
    const registry = createSourceRegistry({
      connect: (descriptor) =>
        ({
          descriptor,
          connect: async () => undefined,
          disconnect: () => undefined,
          source: {},
          subscribe: () => () => undefined,
          status: { state: "ready" },
        }) as never,
    });
    registry.add(SHARED);
    resetSourceRegistry(registry);
    setActiveConnection("own-pc");
    const reload = vi.fn();
    expect(openSource("shared-1", reload)).toBe("switched");
    expect(registry.current().descriptor.sourceId).toBe("shared-1");
    expect(pendingJoinOpen()).toBe("shared-1");
    expect(reload).not.toHaveBeenCalled();
    // 回到页面的主连接也不重载。
    expect(openSource("own-pc", reload)).toBe("switched");
    expect(registry.current().descriptor.sourceId).toBe("local");
    expect(reload).not.toHaveBeenCalled();
  });

  it("没挂着的连接才记下进入意图并重载一次", () => {
    resetSourceRegistry(createSourceRegistry());
    const reload = vi.fn();
    expect(openSource("elsewhere", reload)).toBe("reloaded");
    expect(takeEnterIntent()).toBe("elsewhere");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("只有「管理连接」回选择页", () => {
    const reload = vi.fn();
    manageConnections(reload);
    expect(location.hash).toBe("#connections");
    expect(reload).toHaveBeenCalledOnce();
  });
});
