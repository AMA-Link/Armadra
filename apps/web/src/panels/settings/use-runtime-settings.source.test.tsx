import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Source, setCurrentSourceResolver } from "../../api/source";
import { useAgentsQuery } from "../../app/use-agents";
import { useRuntimeSettings } from "./use-runtime-settings";

/**
 * 设置恒指本机（重设计 B4）：打开别人的工作空间（当前源是别人的 core）时，设置页
 * 读写的仍是本机 core；只有「当前工作空间」页跟随打开的工作空间。
 */

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let remoteCalls: string[];
let localCalls: string[];

beforeEach(() => {
  remoteCalls = [];
  localCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      localCalls.push(String(input));
      const url = String(input);
      return answer(200, {
        json: url.includes("/api/rpc/settings/") ? {} : [],
      });
    }),
  );
  const remote = {
    sourceId: "shared-1",
    httpBase: "http://remote.example",
    wsBase: "ws://remote.example",
    credentials: { mode: "none" },
    fetch: async (input: string | URL | Request) => {
      remoteCalls.push(String(input));
      return answer(403, { code: "forbidden", message: "no" });
    },
  } as unknown as Source;
  setCurrentSourceResolver(() => remote);
});

afterEach(() => {
  setCurrentSourceResolver(null);
  vi.unstubAllGlobals();
});

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("设置页读写本机", () => {
  it("scope: local 在别人的工作空间打开时仍读本机，不碰对方（没有 403）", async () => {
    const { result } = renderHook(
      () => useRuntimeSettings({ scope: "local" }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.settings.isSuccess).toBe(true));
    expect(remoteCalls).toEqual([]);
    expect(
      localCalls.some((url) => url.endsWith("/api/rpc/settings/get")),
    ).toBe(true);
  });

  it("scope: local 的保存也发往本机", async () => {
    const { result } = renderHook(
      () => useRuntimeSettings({ scope: "local" }),
      { wrapper: wrapper() },
    );
    result.current.save.mutate({ hooks: { replyApprovals: true } });
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    expect(remoteCalls).toEqual([]);
    expect(
      localCalls.some((url) => url.endsWith("/api/rpc/settings/update")),
    ).toBe(true);
  });

  it("scope: current（当前工作空间页）跟随打开的工作空间", async () => {
    const { result } = renderHook(
      () => useRuntimeSettings({ scope: "current" }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.settings.isError).toBe(true));
    expect(remoteCalls.some((url) => url.includes("remote.example"))).toBe(
      true,
    );
    expect(localCalls).toEqual([]);
  });

  it("设置页的 Agent 清单（local）读本机，缺省读当前源", async () => {
    const local = renderHook(() => useAgentsQuery("local"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(local.result.current.isSuccess).toBe(true));
    expect(
      remoteCalls.filter((url) => /\/api\/(rpc\/)?agents/.test(url)),
    ).toEqual([]);
    renderHook(() => useAgentsQuery(), { wrapper: wrapper() });
    await waitFor(() =>
      expect(remoteCalls.some((url) => /\/api\/(rpc\/)?agents/.test(url))).toBe(
        true,
      ),
    );
  });
});
