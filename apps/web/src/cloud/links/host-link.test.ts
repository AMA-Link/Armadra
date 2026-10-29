import { describe, expect, it, vi } from "vitest";

import type { HostChannel, HostRequest } from "../host-channel";
import { consoleRemote, createHostLink } from "./host-link";

const ISSUER = "https://app.example";
const SOURCE = "a".repeat(32);
const URL_OK = `${ISSUER}/j/lnk_1#secret.invite.0123456789abcdef`;

const reply = (status: number, body: unknown) =>
  ({
    ok: status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response;

function channel(create: () => Response, trusted = true) {
  const calls: { path: string; init: HostRequest }[] = [];
  const fake: HostChannel = {
    probe: vi.fn(async () => trusted),
    request: vi.fn(async (_id: string, path: string, init: HostRequest) => {
      calls.push({ path, init });
      if (path === "/api/sources")
        return reply(200, {
          remotes: [
            {
              serviceId: "svc",
              kind: "saas",
              issuer: `${ISSUER}/`,
              registered: true,
            },
          ],
        });
      return create();
    }),
    dispose: vi.fn(),
  };
  return { fake, calls };
}

const input = {
  role: "operator",
  ttlMs: 86_400_000,
  maxUses: 5,
  label: "",
} as const;

describe("createHostLink", () => {
  it("可执行的链接不带只读、空备注不带 label；签发方按来源比（尾斜杠不算差）", async () => {
    const { fake, calls } = channel(() => reply(200, { url: URL_OK }));
    expect(await createHostLink(fake, ISSUER, SOURCE, input)).toBe(URL_OK);
    expect(calls[1]!.init.body).toEqual({
      serviceId: "svc",
      workspaceId: "",
      target: "host",
      role: "operator",
      ttlMs: 86_400_000,
      maxUses: 5,
    });
  });

  it("主机答的地址不在控制台来源的 /j/ 下：不交出去", async () => {
    const { fake } = channel(() =>
      reply(200, { url: "https://evil.example/j/x#s" }),
    );
    await expect(
      createHostLink(fake, ISSUER, SOURCE, input),
    ).rejects.toMatchObject({ code: "e2e_device_unavailable" });
  });

  it("主机列源表被拒：原样带码", async () => {
    const fake: HostChannel = {
      probe: async () => true,
      request: async () => reply(403, { code: "forbidden" }),
      dispose: () => undefined,
    };
    await expect(
      createHostLink(fake, ISSUER, SOURCE, input),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("consoleRemote", () => {
  it("登记着的优先；访客行、别的签发方、个人中转不算", () => {
    expect(
      consoleRemote(
        [
          {
            serviceId: "g",
            kind: "saas",
            issuer: ISSUER,
            guest: true,
            registered: true,
          },
          {
            serviceId: "p",
            kind: "personal",
            issuer: ISSUER,
            registered: true,
          },
          {
            serviceId: "o",
            kind: "saas",
            issuer: "https://other.example",
            registered: true,
          },
          { serviceId: "u", kind: "saas", issuer: ISSUER, registered: false },
          { serviceId: "r", kind: "saas", issuer: ISSUER, registered: true },
        ],
        ISSUER,
      ),
    ).toBe("r");
    expect(consoleRemote([], ISSUER)).toBeUndefined();
  });
});
