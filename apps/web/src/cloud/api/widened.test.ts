import { cloudContract } from "@armadra/platform-protocol/cloud-api";
import { ERROR_CODES } from "@armadra/platform-protocol/errors";
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
  // 每条先断言一个已有字段：schema 结构变了（shape 取不到）时，「没有」不会悄悄通过。
  it("links.get 出参没有 ownerName", () => {
    const shape = procedure("links", "get").outputSchema?.shape;
    expect(shape).toHaveProperty("label");
    expect(shape).not.toHaveProperty("ownerName");
  });
  it("auth.deviceGet 出参没有 ipPrefix", () => {
    const shape = procedure("auth", "deviceGet").outputSchema?.shape;
    expect(shape).toHaveProperty("platform");
    expect(shape).not.toHaveProperty("ipPrefix");
  });
  it("admin.relayNodeDrain 入参没有 reason", () => {
    const shape = procedure("admin", "relayNodeDrain").inputSchema?.shape;
    expect(shape).toHaveProperty("node");
    expect(shape).not.toHaveProperty("reason");
  });
  it("team_hosts_online 尚不在协议包的错误码里", () => {
    // 先断言一个已有的码：枚举取不到时「没有」不会悄悄通过。
    expect(ERROR_CODES).toContain("team_deleted");
    expect(ERROR_CODES).not.toContain("team_hosts_online");
  });
});
