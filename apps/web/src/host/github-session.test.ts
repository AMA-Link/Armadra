import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IdentityHello } from "../api/identity";

/**
 * 回环主人开发模式（`armadra.sh run web`，#977）：core 在 hello 里报
 * `identity.loopback-owner.v1`，页面没有会话也按本机主人开代码托管面板；
 * 其它 core 没有这个能力位，没有会话仍是 `signedOut`。
 */

const api = vi.hoisted(() => ({
  hello: vi.fn(),
  resume: vi.fn(),
  openGithub: vi.fn(),
}));

vi.mock("../api/client", () => ({
  runtimeApi: { openGithub: api.openGithub },
}));

vi.mock("../api/identity", async (original) => ({
  ...(await original<typeof import("../api/identity")>()),
  identityHello: api.hello,
  resumeIdentity: api.resume,
  hasSessionCapability: () => true,
}));

import { useGithubSession } from "./github-session";

function hello(capabilities: string[]): IdentityHello {
  return {
    protocol: { major: 1, minor: 51 },
    hostInstanceId: "i",
    sourceId: "host-1",
    capabilities,
    maxFrameBytes: 1048576,
    hostName: "h",
  } as unknown as IdentityHello;
}

beforeEach(() => {
  api.hello.mockReset();
  api.resume.mockReset();
  api.openGithub.mockReset();
  api.resume.mockResolvedValue(null);
  api.openGithub.mockReturnValue({
    getCredential: async () => ({ available: true }),
  });
  useGithubSession.getState().reset();
});

describe("回环主人没有会话", () => {
  it("hello 报了回环主人能力位时按本机主人可用", async () => {
    api.hello.mockResolvedValue(
      hello(["github.issues.v1", "identity.loopback-owner.v1"]),
    );
    await useGithubSession.getState().connect("ws-1");
    const state = useGithubSession.getState().state;
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.canWrite).toBe(true);
    expect(state.session.native).toBeUndefined();
    expect(state.session.csrfToken).toBeUndefined();
  });

  it("没有这个能力位的 core 仍报没配对", async () => {
    api.hello.mockResolvedValue(hello(["github.issues.v1"]));
    await useGithubSession.getState().connect("ws-1");
    expect(useGithubSession.getState().state).toEqual({
      status: "blocked",
      reason: "signedOut",
    });
  });
});
