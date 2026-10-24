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
import type {
  DeviceEvent,
  DeviceStatus,
  TrustedDeviceRow,
} from "../relay/e2e/devices";
import { TrustReporter } from "../relay/e2e/trust-report";
import { tempDir } from "../testing/temp-dir";
import { fixture, migrationsDir } from "../workspaces/fixture";
import { memoryBackend, plainSealed } from "./fake.fixture";
import { networkTransport, type OutboundRequest } from "./http-client";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * 对着真实的 Armadra 云控制面（Go）验证 core 待信任上报器（契约 §31）发出的请求体被
 * 真实服务端接受：`sources.trustRequest`（含 `pendingId`）与 `sources.trustResolve`
 * （`trusted` / `expired`）。上报器吞掉所有失败，所以这里记下每次答复的状态码逐条核对，
 * 再用批准人的 `trust.list` 看云端的状态。
 *
 * 默认跳过；`tools/probes/saas-device-register.mjs` 起好控制面并设下面的环境变量才跑：
 * `SAAS_CLOUD_BASE`、`SAAS_APPROVER_TOKEN`、`SAAS_APPROVER_PASSWORD`、
 * `SAAS_MEMBER_ACCOUNT`、`SAAS_MEMBER_DEVICE`（团队成员 B 的账号与云端设备标识）。
 * 云端要 0.11.0 起才有这两个端点；登记时的 core 版本报 0.11.0。
 */
const base = process.env.SAAS_CLOUD_BASE;
const token = process.env.SAAS_APPROVER_TOKEN ?? "";
const password = process.env.SAAS_APPROVER_PASSWORD ?? "";
const memberId = process.env.SAAS_MEMBER_ACCOUNT ?? "";
const memberDevice = process.env.SAAS_MEMBER_DEVICE ?? "";

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-forwarded-for": "10.9.9.9",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

async function listed() {
  const answer = await call("GET", "/v1/trust-requests");
  expect(answer.status).toBe(200);
  return answer.body.requests as Record<string, unknown>[];
}

describe.skipIf(base === undefined || memberDevice === "")(
  "真实控制面：待信任上报",
  () => {
    it("trustRequest / trustResolve 的请求体被接受，云端状态随之变化", async () => {
      const opened = openFreshDatabase(
        join(tempDir("armadra-saas-trust-"), "canvas.db"),
        migrationsDir(),
      );
      const cleanups: (() => void)[] = [];
      try {
        const instance = "0123456789abcdef0123456789abcdef";
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
            cloudDomain.attachRelay(fakeRelay());
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
            name: "saas-trust-probe",
          }),
          peer: new SourceClient(
            networkTransport,
            plainSealed(networkTransport),
          ),
          hostId: () => hostId,
          hostLabel: () => "this-mac",
          log: { info: () => undefined, warn: () => undefined },
          cloud: () => ({
            registered: (issuer) => cloudDomain.registered(issuer),
            revoke: (input) => cloudDomain.revoke(input, owner),
            register: (input) => cloudDomain.register(input, owner),
            bind: (assertion) => cloudDomain.bind(owner, assertion),
            sourceId: async () => (await cloudDomain.status()).sourceId,
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
        expect(
          (await call("POST", "/v1/auth/step-up", { password })).status,
        ).toBe(200);
        expect(
          (
            await call("POST", "/v1/auth/device/approve", {
              userCode,
              approve: true,
            })
          ).status,
        ).toBe(200);
        let status = "pending";
        for (let tries = 0; tries < 10 && status === "pending"; tries += 1) {
          await new Promise((done) => setTimeout(done, intervalMs + 100));
          status = (await service.remoteDevicePoll(serviceId)).status;
        }
        expect(status).toBe("ready");
        const { spaces } = await service.remoteSpaces(serviceId);
        const team = spaces.find((one) => one.kind === "team");
        if (team?.kind !== "team") throw new Error("没有团队空间");
        await service.remoteRegister({
          serviceId,
          space: { kind: "team", teamId: team.teamId },
        });
        // 成员 B 要对这台主机有访问权，云端才收它的待信任上报。
        await service.console.grantCreate({
          serviceId,
          subject: { kind: "member", accountId: memberId },
          role: "viewer",
          workspaceIds: [],
          expiresAtMs: Date.now() + 24 * 3_600_000,
        });
        expect(await listed()).toEqual([]);

        // 上报器接真实传输与真实源 JWS；记下每次的答复状态。
        const sent: Array<{ path: string; status: number; body: unknown }> = [];
        const rows = new Map<string, DeviceStatus>();
        const reporter = new TrustReporter({
          transport: async (request: OutboundRequest) => {
            const answer = await networkTransport(request);
            sent.push({
              path: new URL(request.url).pathname,
              status: answer.status,
              body: answer.body,
            });
            return answer;
          },
          signSourceJws: (audience) => cloudDomain.signSourceJws(audience),
          fingerprint: (issuer) => cloudDomain.fingerprint(issuer),
          modeOf: (issuer) => (issuer === base ? "saas" : undefined),
          lookup: (pendingId) => {
            const state = rows.get(pendingId);
            return state === undefined
              ? undefined
              : ({ deviceId: "local-1", status: state } as TrustedDeviceRow);
          },
        });
        cleanups.push(() => reporter.close());
        const pendingEvent = (pendingId: string): DeviceEvent => ({
          type: "devices.pending",
          pendingId,
          deviceId: "local-1",
          label: "iPad",
          platform: "ios",
          principalId: "principal-1",
          issuer: base ?? "",
          issuerDeviceId: memberDevice,
          accountId: memberId,
          expiresAtMs: Date.now() + 30 * 60_000,
        });

        // 报一条：云端登记为 pending，列表里能看到，带着本机的 pendingId。
        rows.set("pend-aaa", "pending");
        reporter.handle(pendingEvent("pend-aaa"));
        await reporter.idle();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          path: "/v1/sources/me/trust-requests",
          status: 200,
          body: { status: "pending" },
        });
        const requests = await listed();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          pendingId: "pend-aaa",
          member: { accountId: memberId },
        });
        // 校验码不出 core，云端的请求里也不会有。
        expect(JSON.stringify(requests)).not.toMatch(
          /\bsas\b|verification|checkCode/i,
        );

        // 本机批准：收尾 trusted，云端把请求移出待办。
        rows.set("pend-aaa", "trusted");
        reporter.handle({ type: "devices.changed", deviceId: "local-1" });
        await reporter.idle();
        expect(sent[1]).toMatchObject({
          path: "/v1/sources/me/trust-requests/pend-aaa/resolve",
          status: 200,
        });
        expect(await listed()).toEqual([]);

        // 再来一条然后过期（本地条目消失）：收尾 expired，同样被接受。
        rows.set("pend-bbb", "pending");
        reporter.handle(pendingEvent("pend-bbb"));
        await reporter.idle();
        expect(sent[2]).toMatchObject({ status: 200 });
        expect(await listed()).toHaveLength(1);
        rows.delete("pend-bbb");
        reporter.handle({ type: "devices.changed", deviceId: "local-1" });
        await reporter.idle();
        expect(sent[3]).toMatchObject({
          path: "/v1/sources/me/trust-requests/pend-bbb/resolve",
          status: 200,
        });
        expect(await listed()).toEqual([]);
        expect(sent.every((one) => one.status === 200)).toBe(true);
      } finally {
        for (const cleanup of cleanups) cleanup();
        opened.close();
      }
    }, 90_000);
  },
);
