import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import { memoryBackend, plainSealed } from "./fake.fixture";
import { networkTransport } from "./http-client";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * 对着真实的 Armadra 云控制面（Go）跑 core 的设备码登录、空间与注册令牌（契约 §33.11）。
 * 只在 `tools/probes/saas-device-register.mjs` 起好控制面并设了下面几个环境变量时运行：
 * `SAAS_CLOUD_BASE`（控制面地址）、`SAAS_APPROVER_TOKEN`（已验证邮箱、建好团队的账号的
 * 访问令牌）、`SAAS_APPROVER_PASSWORD`（该账号口令，批准新设备要先提权）。
 */
const base = process.env.SAAS_CLOUD_BASE;
const token = process.env.SAAS_APPROVER_TOKEN ?? "";
const password = process.env.SAAS_APPROVER_PASSWORD ?? "";
const HOST_ID = "f".repeat(32);

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-forwarded-for": "10.9.9.9",
    },
    body: JSON.stringify(body),
  });
  return response.status;
}

describe.skipIf(base === undefined)("真实控制面", () => {
  it("设备码登录 → 批准 → 空间 → 注册令牌 → 登记", async () => {
    const opened = openFreshDatabase(
      join(tempDir("armadra-saas-"), "canvas.db"),
      migrationsDir(),
    );
    try {
      const registrations: { registrationToken: string }[] = [];
      const service = new SourcesService({
        store: new SourcesStore(opened.database),
        secrets: new SourceSecrets(() => memoryBackend()),
        remote: new RemoteClient(networkTransport, {
          platform: "desktop",
          name: "saas-probe",
        }),
        peer: new SourceClient(networkTransport, plainSealed(networkTransport)),
        hostId: () => HOST_ID,
        hostLabel: () => "this-mac",
        log: { info: () => undefined, warn: () => undefined },
        cloud: () => ({
          registered: () => false,
          revoke: async () => ({}),
          register: async (input) => {
            registrations.push(input);
            return { sourceId: HOST_ID };
          },
          bind: async () => ({}),
        }),
      });
      service.ensureLocal();
      const added = await service.remoteAdd({
        kind: "saas",
        issuer: base ?? "",
      });
      if (added.next === "ready") throw new Error("SaaS 加入不该直接就绪");
      const { userCode, intervalMs } = added.next.deviceCode;
      const serviceId = added.remote.serviceId;
      expect(userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      expect(await service.remoteDevicePoll(serviceId)).toEqual({
        status: "pending",
      });

      expect(await post("/v1/auth/step-up", { password })).toBe(200);
      expect(
        await post("/v1/auth/device/approve", { userCode, approve: true }),
      ).toBe(200);

      let status = "pending";
      for (let tries = 0; tries < 10 && status === "pending"; tries += 1) {
        await new Promise((done) => setTimeout(done, intervalMs + 100));
        status = (await service.remoteDevicePoll(serviceId)).status;
      }
      expect(status).toBe("ready");

      const { spaces } = await service.remoteSpaces(serviceId);
      const team = spaces.find((one) => one.kind === "team");
      expect(spaces.some((one) => one.kind === "personal")).toBe(true);
      if (team?.kind !== "team") throw new Error("没有团队空间");
      const done = await service.remoteRegister({
        serviceId,
        space: { kind: "team", teamId: team.teamId },
      });
      expect(done.sourceId).toBe(HOST_ID);
      expect(registrations[0]?.registrationToken.length).toBeGreaterThan(20);
    } finally {
      opened.close();
    }
  }, 60_000);
});
