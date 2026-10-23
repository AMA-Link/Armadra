import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import { AccountsService } from "../identity/accounts";
import { Authorizer } from "../identity/authorize";
import { fakeRelay } from "../identity/cloud/fake.fixture";
import { installCloud } from "../identity/cloud";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import { allScopes } from "../identity/scopes";
import { tempDir } from "../testing/temp-dir";
import { fixture, migrationsDir } from "../workspaces/fixture";
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
 * 登记走真实的 `CloudRegistry`（`sources.register` 带注册令牌、取 JWKS、写登记行）；
 * 中继隧道换成假的，所以不验证隧道。
 */
const base = process.env.SAAS_CLOUD_BASE;
const token = process.env.SAAS_APPROVER_TOKEN ?? "";
const password = process.env.SAAS_APPROVER_PASSWORD ?? "";

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
    const cleanups: (() => void)[] = [];
    try {
      const instance = "0123456789abcdef0123456789abcdef";
      const relay = fakeRelay();
      let identity!: IdentityStore;
      let owner = "";
      let cloudDomain!: ReturnType<typeof installCloud>;
      const core = fixture([
        (context) => {
          identity = new IdentityStore(context.db.database);
          const identityService = new IdentityService(identity, instance);
          cloudDomain = installCloud(context, {
            store: identity,
            service: identityService,
            accounts: new AccountsService({ store: identity }),
            authorizer: new Authorizer(identity),
            capabilities: () => ["identity.native-session.v1"],
            coreVersion: "0.11.0",
            secrets: () => memoryBackend(),
          });
          cloudDomain.attachRelay(relay);
          const ticket = identityService.issueBootstrap({
            hostId: identity.hostId(),
            instanceId: instance,
            origin: "http://127.0.0.1:1420",
            deviceName: "probe",
            scopes: allScopes(),
          });
          owner = identityService.consumeBootstrap({
            ticket: ticket.ticket,
            hostId: identity.hostId(),
            instanceId: instance,
            origin: "http://127.0.0.1:1420",
          }).principal.principalId;
        },
      ]);
      cleanups.push(() => core.close());
      const hostId = identity.hostId();
      const service = new SourcesService({
        store: new SourcesStore(opened.database),
        secrets: new SourceSecrets(() => memoryBackend()),
        remote: new RemoteClient(networkTransport, {
          platform: "desktop",
          name: "saas-probe",
        }),
        peer: new SourceClient(networkTransport, plainSealed(networkTransport)),
        hostId: () => hostId,
        hostLabel: () => "this-mac",
        log: { info: () => undefined, warn: () => undefined },
        cloud: () => ({
          registered: (issuer) => cloudDomain.registered(issuer),
          revoke: (input) => cloudDomain.revoke(input, owner),
          register: (input) => cloudDomain.register(input, owner),
          bind: (assertion) => cloudDomain.bind(owner, assertion),
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
      expect(done.sourceId).toBe(hostId);
      expect(done.remote.registered).toBe(true);
      expect(cloudDomain.registered(base ?? "")).toBe(true);
      expect(relay.started).toEqual([base]);
    } finally {
      for (const cleanup of cleanups) cleanup();
      opened.close();
    }
  }, 60_000);
});
