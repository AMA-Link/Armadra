import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const avatars = vi.fn(async (_target: unknown, ids: readonly number[]) => ({
  avatars: ids.map((id) => ({
    id,
    dataUrl: id % 2 === 0 ? `data:image/png;base64,${id}` : null,
  })),
}));

vi.mock("../../../git/gateway", () => ({
  gitGateway: {
    avatars: (target: unknown, ids: readonly number[]) => avatars(target, ids),
  },
}));

import { resetAvatarCache, useAvatars } from "./use-avatars";

const target = { workspaceId: "w", repositoryPath: "/p" } as never;

afterEach(() => {
  cleanup();
  resetAvatarCache();
  avatars.mockClear();
});

describe("页面头像缓存（#942）", () => {
  it("一批至多 50 个，问完再问下一批", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => index + 1);
    const { result } = renderHook(() => useAvatars(target, ids));
    await waitFor(() => expect(avatars).toHaveBeenCalledTimes(3));
    expect(avatars.mock.calls.map((call) => call[1].length)).toEqual([
      50, 50, 20,
    ]);
    await waitFor(() => expect(result.current.size).toBe(60));
  });

  it("翻页只问新出现的 id；问不到的也记下", async () => {
    const { rerender } = renderHook(({ ids }) => useAvatars(target, ids), {
      initialProps: { ids: [1, 2] },
    });
    await waitFor(() => expect(avatars).toHaveBeenCalledTimes(1));
    rerender({ ids: [1, 2, 3] });
    await waitFor(() => expect(avatars).toHaveBeenCalledTimes(2));
    expect(avatars.mock.calls[1]![1]).toEqual([3]);
  });

  it("两个视图共用一份：第二个不再请求", async () => {
    const first = renderHook(() => useAvatars(target, [4]));
    await waitFor(() => expect(first.result.current.get(4)).toBeTruthy());
    const second = renderHook(() => useAvatars(target, [4]));
    expect(second.result.current.get(4)).toBe("data:image/png;base64,4");
    expect(avatars).toHaveBeenCalledTimes(1);
  });
});
