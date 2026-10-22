import {
  cloudContract,
  listProcedures,
} from "@armadra/platform-protocol/cloud-api";
import { describe, expect, it } from "vitest";

import { CloudConsoleError } from "../api/errors";
import {
  createMockApi,
  goldenFixture,
  mockOptionsFromSearch,
} from "./create-mock-client";
import { MOCK_HOSTS, MOCK_TEAMS } from "./fixtures";

/** 控制台调不了的范围：源 core、支付回调、中继节点。 */
const NOT_FOR_CONSOLE = new Set(["source", "billing-webhook", "relay-node"]);
const entries = listProcedures(cloudContract);

async function validate(schema: unknown, value: unknown) {
  const standard = (
    schema as { "~standard": { validate(v: unknown): unknown } }
  )["~standard"];
  return (await standard.validate(value)) as { issues?: unknown[] };
}

/** 路径 `a.b` → mock 客户端上的函数。 */
function procedureOf(
  client: unknown,
  key: string,
): ((input: unknown) => Promise<unknown>) | undefined {
  const [group = "", name = ""] = key.split(".");
  return (client as Record<string, Record<string, never>>)[group]?.[name];
}

describe("mock 与协议包契约一致", () => {
  it("契约里的每个过程 mock 都有实现（协议包升级漏掉的直接让这里失败）", () => {
    const api = createMockApi();
    expect(entries.length).toBeGreaterThan(100);
    for (const entry of entries)
      expect(procedureOf(api.client, entry.key), entry.key).toBeTypeOf(
        "function",
      );
  });

  it("控制台可调用的每个过程：黄金入参被接受，出参过契约的 zod schema", async () => {
    for (const entry of entries) {
      const callable = entry.meta.scope.some(
        (scope) => !NOT_FOR_CONSOLE.has(scope),
      );
      const api = createMockApi({
        operatorAccount: true,
        operatorSession: true,
      });
      const asOperator =
        !entry.meta.scope.includes("session") &&
        entry.meta.scope.includes("operator");
      const call = procedureOf(asOperator ? api.ops : api.client, entry.key)!;
      const input = goldenFixture(entry.key).input ?? {};
      if (!callable) {
        await expect(call(input), entry.key).rejects.toMatchObject({
          code: "forbidden",
        });
        continue;
      }
      const output = await call(input);
      const outputSchema = (
        entry.procedure["~orpc"] as { outputSchema: unknown }
      ).outputSchema;
      expect(
        (await validate(outputSchema, output)).issues,
        entry.key,
      ).toBeUndefined();
    }
  });

  it("入参不合契约答 bad_request，不把错的东西递给后面", async () => {
    const api = createMockApi();
    await expect(
      api.client.sources.get({ sourceId: "不是 hex" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      status: 400,
    });
  });

  it("没登录答 session_expired，登录后能读；运营接口没有运营会话答 forbidden", async () => {
    const api = createMockApi({ signedIn: false, operatorAccount: true });
    await expect(api.client.me.get({})).rejects.toMatchObject({
      code: "session_expired",
      status: 401,
    });
    await api.client.auth.login({
      account: "zhangsan@example.com",
      password: "x",
      device: { platform: "browser", name: "Web" },
    });
    await expect(api.client.me.get({})).resolves.toMatchObject({
      displayName: "张三",
    });
    await expect(api.ops.admin.tenants({})).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("运营登录：口令 → 两步验证 → 运营会话；非运营账号答 forbidden", async () => {
    const login = {
      account: "zhangsan@example.com",
      password: "x",
      device: { platform: "browser", name: "Web" },
      scope: "operator",
    } as const;
    const plain = createMockApi();
    await expect(plain.ops.auth.login(login)).rejects.toMatchObject({
      code: "forbidden",
    });

    const api = createMockApi({ operatorAccount: true });
    expect(api.operator.active()).toBe(false);
    expect(await api.ops.auth.login(login)).toHaveProperty("mfa");
    await api.ops.auth.mfaVerify({ challengeId: "mock-mfa", code: "123456" });
    expect(api.operator.active()).toBe(true);
    await expect(api.ops.admin.tenants({})).resolves.toBeTruthy();
    await api.signOut();
    expect(api.operator.active()).toBe(false);
  });

  it("角色表：团队范围的过程按角色答 forbidden", async () => {
    const [rd] = MOCK_TEAMS;
    const space = { kind: "team", teamId: rd!.teamId } as const;
    const admin = createMockApi({ roles: { rd: "admin" } });
    const member = createMockApi({ roles: { rd: "member" } });
    const billing = createMockApi({ roles: { rd: "billing" } });
    const input = {
      ...(goldenFixture("audit.list").input as object),
      teamId: rd!.teamId,
    };
    await expect(admin.client.audit.list(input)).resolves.toBeTruthy();
    await expect(member.client.audit.list(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(billing.client.audit.list(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    // 主机目录只列这个空间的主机。
    const { sources } = (await admin.client.sources.list({ space })) as {
      sources: unknown[];
    };
    expect(sources).toHaveLength(
      MOCK_HOSTS.filter(
        (row) => row.space?.kind === "team" && row.space.teamId === rd!.teamId,
      ).length,
    );
  });

  it("可注入失败码与延迟，limit_reached 带 quota", async () => {
    const api = createMockApi({ fail: { "sources.list": "limit_reached" } });
    const error = await api.client.sources.list({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudConsoleError);
    expect(error).toMatchObject({
      code: "limit_reached",
      status: 429,
      details: { quota: "hosts" },
    });
    expect(
      mockOptionsFromSearch(
        "?mock&mockFail=sources.list:limit_reached&mockFail=me.get:unavailable&mockLatency=40&mockOperator",
      ),
    ).toEqual({
      fail: { "sources.list": "limit_reached", "me.get": "unavailable" },
      latencyMs: 40,
      operatorAccount: true,
    });
  });
});
