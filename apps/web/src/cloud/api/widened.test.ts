import { cloudContract } from "@armadra/platform-protocol/cloud-api";
import { describe, expect, it } from "vitest";

/**
 * 内置协议包（0.10.0）还没有的可选字段，控制台靠手写放宽对接云端 0.11.0。协议包升级、
 * 这些字段进了 schema 之后，这里会失败：删掉对应的手写放宽（`LinkPage` 的 `Info`、
 * `DevicePage` 的 `DeviceRequest.ipPrefix`、`ops/data.ts` 的 `DrainInput`、
 * `mock/create-mock-client.ts` 的 `WIDENED_OUTPUT`、`sources/cloud-client.ts` 的
 * `ownerName`、`api/errors.ts` 的 `team_hosts_online`）再删除本测试。
 */
type Procedure = {
  "~orpc": {
    inputSchema?: { shape?: Record<string, unknown> };
    outputSchema?: { shape?: Record<string, unknown> };
  };
};

const procedure = (group: string, name: string): Procedure["~orpc"] =>
  (
    (cloudContract as unknown as Record<string, Record<string, Procedure>>)[
      group
    ]![name]! as Procedure
  )["~orpc"];

describe("协议包 0.10.0 尚无的可选字段（升级后删手写放宽）", () => {
  it("links.get 出参没有 ownerName", () => {
    expect(procedure("links", "get").outputSchema?.shape).not.toHaveProperty(
      "ownerName",
    );
  });
  it("auth.deviceGet 出参没有 ipPrefix", () => {
    expect(
      procedure("auth", "deviceGet").outputSchema?.shape,
    ).not.toHaveProperty("ipPrefix");
  });
  it("admin.relayNodeDrain 入参没有 reason", () => {
    expect(
      procedure("admin", "relayNodeDrain").inputSchema?.shape,
    ).not.toHaveProperty("reason");
  });
});
