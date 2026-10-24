import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudKeys } from "../api/keys";
import { keyOfSpace, type CloudSpace } from "../space";
import {
  EndorserProvider,
  type HostEndorser,
  type TrustRequest,
} from "./endorser";
import { useCanEndorse, useRefuseRequest } from "./data";

const SPACE: CloudSpace = { kind: "team", teamId: "team_rd", slug: "rd" };
const REQUEST = {
  requestId: "trq_1",
  sourceId: "src_1",
  pendingId: "pending_1",
} as unknown as TrustRequest;

const host: HostEndorser = {
  canEndorse: async () => true,
  approve: async () => undefined,
};

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <EndorserProvider endorser={host}>{children}</EndorserProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      can: useCanEndorse(SPACE, REQUEST),
      refuse: useRefuseRequest(SPACE),
    }),
    { wrapper },
  );
  return { client, hook };
}

afterEach(() => vi.restoreAllMocks());

describe("背书拒绝记录（#556）", () => {
  it("被强制重拉时保留已记下的拒绝，也不报没有 queryFn", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, hook } = setup();
    await waitFor(() => expect(hook.result.current.can.trusted).toBe(true));
    act(() => hook.result.current.refuse("trq_1"));
    await waitFor(() => expect(hook.result.current.can.trusted).toBe(false));

    // 按前缀把整个空间重拉一遍（含未启用的查询）：拒绝记录不能丢。
    await act(() =>
      client.refetchQueries({
        queryKey: ["cloud", keyOfSpace(SPACE)],
        type: "all",
      }),
    );
    expect(
      client.getQueryData(cloudKeys.endorseRefused(keyOfSpace(SPACE), "trq_1")),
    ).toBe(true);
    expect(hook.result.current.can.trusted).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it("没有记录时重拉得到 false", async () => {
    const { client, hook } = setup();
    await waitFor(() => expect(hook.result.current.can.trusted).toBe(true));
    await act(() =>
      client.refetchQueries({
        queryKey: cloudKeys.endorseRefused(keyOfSpace(SPACE), "trq_1"),
        type: "all",
      }),
    );
    expect(hook.result.current.can.trusted).toBe(true);
  });
});
