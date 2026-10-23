import { describe, expect, it } from "vitest";

import type { OutboundRequest } from "../../sources/http-client";
import type { DeviceEvent, DeviceStatus, TrustedDeviceRow } from "./devices";
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
});
