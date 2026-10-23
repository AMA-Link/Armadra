import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { OutboundRequest } from "../../sources/http-client";
import {
  type DeviceEvent,
  DeviceRegistry,
  type DeviceStatus,
  type TrustedDeviceRow,
  TrustedDeviceStore,
} from "./devices";
import { backoffMs, MAX_ATTEMPTS, TrustReporter } from "./trust-report";

const ISSUER = "https://cloud.test";
let clock = 1_000_000;

type Pending = Extract<DeviceEvent, { type: "devices.pending" }>;

function pending(over: Partial<Pending> = {}): Pending {
  return {
    type: "devices.pending",
    pendingId: "p1",
    deviceId: "local-d1",
    label: "iPad",
    platform: "ios",
    principalId: "pr1",
    issuer: ISSUER,
    issuerDeviceId: "cloud-d1",
    accountId: "acc1",
    expiresAtMs: clock + 30 * 60_000,
    ...over,
  };
}

function harness(
  answers: Array<{ status: number; body?: unknown } | Error>,
  mode: "saas" | "personal" | "none" = "saas",
) {
  const calls: OutboundRequest[] = [];
  const rows = new Map<string, DeviceStatus>([["p1", "pending"]]);
  const timers: Array<{ run: () => void; ms: number }> = [];
  const reporter = new TrustReporter({
    transport: async (request) => {
      calls.push(request);
      const next = answers.shift() ?? { status: 200, body: {} };
      if (next instanceof Error) throw next;
      return { status: next.status, body: next.body };
    },
    signSourceJws: async (aud) => `jws-for-${aud}`,
    fingerprint: () => "",
    modeOf: () => (mode === "none" ? undefined : mode),
    lookup: (id) => {
      const status = rows.get(id);
      return status === undefined
        ? undefined
        : ({ deviceId: "local-d1", status } as TrustedDeviceRow);
    },
    now: () => clock,
    schedule: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    },
  });
  return { reporter, calls, rows, timers };
}

describe("TrustReporter", () => {
  it("进入待确认时带源身份上报，只含约定字段、不含校验码", async () => {
    const h = harness([
      { status: 200, body: { requestId: "r1", status: "pending" } },
    ]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${ISSUER}/v1/sources/me/trust-requests`);
    expect(call.headers?.authorization).toBe(`Source jws-for-${ISSUER}`);
    expect(call.body).toEqual({
      pendingId: "p1",
      accountId: "acc1",
      deviceId: "cloud-d1",
      expiresAtMs: clock + 30 * 60_000,
    });
    expect(JSON.stringify(call.body)).not.toMatch(/sas/i);
  });

  it("到期时间不超过 24 小时", async () => {
    const h = harness([{ status: 200 }]);
    h.reporter.handle(pending({ expiresAtMs: clock + 48 * 3_600_000 }));
    await h.reporter.idle();
    expect((h.calls[0]!.body as { expiresAtMs: number }).expiresAtMs).toBe(
      clock + 24 * 3_600_000,
    );
  });

  it("个人中转与未登记的 issuer 不上报", async () => {
    for (const mode of ["personal", "none"] as const) {
      const h = harness([], mode);
      h.reporter.handle(pending());
      h.reporter.handle({ type: "devices.changed", deviceId: "local-d1" });
      await h.reporter.idle();
      expect(h.calls).toHaveLength(0);
    }
  });

  it("冷却期答 rejected 是正常情况：不重试", async () => {
    const h = harness([
      { status: 200, body: { requestId: "r1", status: "rejected" } },
    ]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
  });

  it.each([400, 403, 404, 409, 501])("答 %i 不重试", async (status) => {
    const h = harness([{ status }]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
  });

  it("网络失败、429、5xx 有界退避重试，之后成功", async () => {
    const h = harness([
      new Error("down"),
      { status: 429 },
      { status: 503 },
      { status: 200, body: { requestId: "r", status: "pending" } },
    ]);
    // 退避定时器立即触发。
    const run = h.reporter.idle();
    h.reporter.handle(pending());
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
      for (const timer of [...h.timers]) {
        h.timers.splice(h.timers.indexOf(timer), 1);
        if (timer.ms < 30 * 60_000) timer.run();
      }
    }
    await run;
    await h.reporter.idle();
    expect(h.calls).toHaveLength(4);
  });

  it("一直失败时次数有上限", async () => {
    const h = harness(Array.from({ length: 20 }, () => ({ status: 500 })));
    h.reporter.handle(pending());
    for (let i = 0; i < 200; i += 1) {
      await Promise.resolve();
      for (const timer of [...h.timers]) {
        h.timers.splice(h.timers.indexOf(timer), 1);
        if (timer.ms < 30 * 60_000) timer.run();
      }
    }
    await h.reporter.idle();
    expect(h.calls).toHaveLength(MAX_ATTEMPTS);
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(20)).toBe(60_000);
  });

  it("批准后上报 trusted，云端 404 / 409 当作正常", async () => {
    for (const status of [200, 404, 409]) {
      const h = harness([{ status: 200 }, { status }]);
      h.reporter.handle(pending());
      await h.reporter.idle();
      h.rows.set("p1", "trusted");
      h.reporter.handle({ type: "devices.changed", deviceId: "local-d1" });
      await h.reporter.idle();
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]!.url).toBe(
        `${ISSUER}/v1/sources/me/trust-requests/p1/resolve`,
      );
      expect(h.calls[1]!.body).toEqual({ result: "trusted" });
    }
  });

  it("仍待确认时 devices.changed 不收尾；被拒与撤销按 expired", async () => {
    const h = harness([{ status: 200 }, { status: 200 }]);
    h.reporter.handle(pending());
    h.reporter.handle({ type: "devices.changed", deviceId: "local-d1" });
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
    h.rows.set("p1", "rejected");
    h.reporter.handle({ type: "devices.changed", deviceId: "local-d1" });
    await h.reporter.idle();
    expect(h.calls[1]!.body).toEqual({ result: "expired" });
  });

  it("到期定时器触发时上报 expired，且只收尾一次", async () => {
    const h = harness([{ status: 200 }, { status: 200 }]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    const expiry = h.timers.find((t) => t.ms === 30 * 60_000)!;
    clock += 30 * 60_000;
    expiry.run();
    expiry.run();
    await h.reporter.idle();
    clock -= 30 * 60_000;
    expect(h.calls.map((c) => c.body)).toEqual([
      expect.objectContaining({ pendingId: "p1" }),
      { result: "expired" },
    ]);
  });

  it("设备重连换了 pendingId：旧的收尾为 expired，新的重新上报", async () => {
    const h = harness([{ status: 200 }, { status: 200 }, { status: 200 }]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    h.rows.delete("p1");
    h.rows.set("p2", "pending");
    h.reporter.handle(pending({ pendingId: "p2" }));
    await h.reporter.idle();
    const bodies = h.calls.map((c) => c.body as Record<string, unknown>);
    expect(bodies).toContainEqual({ result: "expired" });
    expect(bodies.filter((b) => b.pendingId === "p2")).toHaveLength(1);
  });

  it("同一 pendingId 重复事件只上报一次（幂等）", async () => {
    const h = harness([{ status: 200 }]);
    h.reporter.handle(pending());
    h.reporter.handle(pending());
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
  });

  it("旧条目的请求还在退避重试时被收尾：不再重试，也不发 resolve", async () => {
    const h = harness([{ status: 500 }, { status: 200 }, { status: 200 }]);
    h.reporter.handle(pending());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);
    // 设备重连换号：p1 收尾，p2 上报。
    h.rows.delete("p1");
    h.rows.set("p2", "pending");
    h.reporter.handle(pending({ pendingId: "p2" }));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
      for (const timer of [...h.timers]) {
        h.timers.splice(h.timers.indexOf(timer), 1);
        if (timer.ms < 30 * 60_000) timer.run();
      }
    }
    await h.reporter.idle();
    const bodies = h.calls.map((c) => c.body as Record<string, unknown>);
    expect(bodies.filter((b) => b.pendingId === "p1")).toHaveLength(1);
    expect(bodies.filter((b) => b.result !== undefined)).toHaveLength(0);
    expect(bodies.filter((b) => b.pendingId === "p2")).toHaveLength(1);
  });

  it("请求答 rejected 后收尾不再发 resolve", async () => {
    const h = harness([
      { status: 200, body: { requestId: "r", status: "rejected" } },
    ]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    h.rows.set("p1", "trusted");
    h.reporter.handle({ type: "devices.changed", deviceId: "local-d1" });
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
  });

  it("到期回调对仍待确认的条目直接按 expired 收尾，不比时钟", async () => {
    const h = harness([{ status: 200 }, { status: 200 }]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    // 时钟没到（比如定时器提前触发）也收尾。
    h.timers.find((t) => t.ms === 30 * 60_000)!.run();
    await h.reporter.idle();
    expect(h.calls[1]!.body).toEqual({ result: "expired" });
  });

  it("close() 之后不再重试", async () => {
    const h = harness([{ status: 500 }, { status: 200 }]);
    h.reporter.handle(pending());
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(h.calls).toHaveLength(1);
    h.reporter.close();
    for (const timer of [...h.timers]) timer.run();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
  });

  it("403 不重试", async () => {
    const h = harness([
      { status: 403, body: { code: "source_access_denied" } },
    ]);
    h.reporter.handle(pending());
    await h.reporter.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.timers.filter((t) => t.ms < 30 * 60_000)).toHaveLength(0);
  });

  it("从 DeviceRegistry.admit 到上报器：accountId 与到期时间原样传递", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = readFileSync(
      new URL("../../db/migrations/0050_trusted_devices.sql", import.meta.url),
      "utf8",
    );
    database.exec(
      "CREATE TABLE identity_principals (principal_id TEXT PRIMARY KEY)",
    );
    database.exec(sql.slice(0, sql.indexOf("-- 经端到端通道签的会话")));
    database.exec("INSERT INTO identity_principals VALUES ('pr1')");
    const store = new TrustedDeviceStore(database);
    const calls: OutboundRequest[] = [];
    const reporter = new TrustReporter({
      transport: async (request) => {
        calls.push(request);
        return { status: 200, body: { requestId: "r", status: "pending" } };
      },
      signSourceJws: async () => "jws",
      fingerprint: () => "",
      modeOf: () => "saas",
      lookup: (id) => store.byRequest(id),
      now: () => clock,
      schedule: () => () => undefined,
    });
    const registry = new DeviceRegistry({
      store,
      emit: (event) => reporter.handle(event),
      now: () => clock,
    });
    const publicKey = new Uint8Array(32).fill(7);
    const verdict = registry.admit({
      device: {
        deviceId: "0".repeat(32),
        publicKey,
        label: "iPad",
        platform: "ios",
        sas: "123456",
      },
      principalId: "pr1",
      issuer: ISSUER,
      issuerDeviceId: "cloud-d9",
      accountId: "acc-sub",
    });
    await reporter.idle();
    expect(verdict.status).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      pendingId: (verdict as { requestId: string }).requestId,
      accountId: "acc-sub",
      deviceId: "cloud-d9",
      expiresAtMs: clock + 30 * 60_000,
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain("123456");
    // 批准后收尾为 trusted。
    registry.approve((verdict as { requestId: string }).requestId, "123456");
    await reporter.idle();
    expect(calls[1]!.body).toEqual({ result: "trusted" });
  });
});
