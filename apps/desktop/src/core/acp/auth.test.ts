import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";

import { AcpClient, fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AcpAuthClient,
  type AuthContext,
  type AuthTerminalRunner,
  authenticateOn,
  canAuthenticate,
  canLogout,
  logoutOn,
  terminalAuthCommand,
} from "./auth";
import { installContract } from "../http/rpc";
import { AcpError, acpClientFeatures } from "./client";
import { FAKE_AGENT, type AcpCore, acpCore } from "./fixture";
import { startAcp } from "./host";
import type { AcpCapabilities } from "./host";

const capabilities = (
  patch: Partial<AcpCapabilities> = {},
): AcpCapabilities => ({
  protocolVersion: 1,
  load: false,
  resume: false,
  list: false,
  close: false,
  images: false,
  embeddedContext: false,
  audio: false,
  mcp: { http: false, sse: false },
  logout: false,
  authMethods: [
    { id: "key", name: "Key", type: "agent" },
    {
      id: "login",
      name: "Log in",
      type: "terminal",
      args: ["--login"],
      env: { TOKEN_MODE: "device", LD_PRELOAD: "/evil.so", "bad name": "x" },
    },
  ],
  authMethodIds: ["key", "login"],
  ...patch,
});

const launch = {
  program: "/bin/agent",
  args: ["acp"],
  cwd: "/work",
  env: { PATH: "/bin", KEEP: "1" },
};

function context(client: AcpAuthClient, caps = capabilities()): AuthContext {
  return { process: { client }, capabilities: caps, launch };
}

describe("feature detection on the client instance", () => {
  it("authenticate is there or it is not", () => {
    expect(canAuthenticate({})).toBe(false);
    expect(canAuthenticate({ authenticate: async () => ({}) })).toBe(true);
  });

  it("logout needs the function and the agent's declaration", () => {
    expect(canLogout({}, { logout: true })).toBe(false);
    expect(canLogout({ logout: async () => ({}) }, { logout: false })).toBe(
      false,
    );
    expect(canLogout({ logout: async () => ({}) }, { logout: true })).toBe(
      true,
    );
    // supportsLogout() 说了算。
    expect(
      canLogout(
        { logout: async () => ({}), supportsLogout: () => false },
        { logout: true },
      ),
    ).toBe(false);
    expect(
      canLogout(
        { logout: async () => ({}), supportsLogout: () => true },
        { logout: false },
      ),
    ).toBe(true);
  });
});

describe("terminalAuthCommand", () => {
  it("appends the method's args and layers its env, without loader variables", () => {
    const method = capabilities().authMethods[1]!;
    const command = terminalAuthCommand(launch, method);
    expect(command.program).toBe("/bin/agent");
    expect(command.args).toEqual(["acp", "--login"]);
    expect(command.env.KEEP).toBe("1");
    expect(command.env.TOKEN_MODE).toBe("device");
    expect(command.env.LD_PRELOAD).toBeUndefined();
    expect(command.env["bad name"]).toBeUndefined();
  });
});

describe("authenticateOn", () => {
  it("completes an agent method through client.authenticate", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    await authenticateOn(context({ authenticate }), { methodId: "key" });
    expect(authenticate).toHaveBeenCalledWith("key", undefined);
  });

  it("turns a refused authenticate into acp_auth_failed", async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error("bad key"));
    await expect(
      authenticateOn(context({ authenticate }), { methodId: "key" }),
    ).rejects.toMatchObject({ code: "acp_auth_failed", message: "bad key" });
  });

  it("runs a terminal method on the host: exit code 0 is success", async () => {
    const run = vi.fn<AuthTerminalRunner>().mockResolvedValue({ exitCode: 0 });
    await authenticateOn(context({ authenticate: async () => ({}) }), {
      methodId: "login",
      runTerminal: run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [command] = run.mock.calls[0]!;
    expect(command.program).toBe("/bin/agent");
    expect(command.args).toEqual(["acp", "--login"]);
    expect(command.cwd).toBe("/work");
    expect(command.env.TOKEN_MODE).toBe("device");
  });

  it("a terminal method that fails or is killed is acp_auth_failed", async () => {
    for (const exitCode of [1, null]) {
      await expect(
        authenticateOn(context({ authenticate: async () => ({}) }), {
          methodId: "login",
          runTerminal: async () => ({ exitCode }),
        }),
      ).rejects.toMatchObject({ code: "acp_auth_failed" });
    }
  });

  it("cancels the terminal run on timeout", async () => {
    let seen: AbortSignal | undefined;
    await expect(
      authenticateOn(context({ authenticate: async () => ({}) }), {
        methodId: "login",
        timeoutMs: 20,
        runTerminal: (_command, signal) =>
          new Promise((resolve) => {
            seen = signal;
            signal.addEventListener("abort", () => resolve({ exitCode: null }));
          }),
      }),
    ).rejects.toMatchObject({ code: "acp_auth_failed" });
    expect(seen?.aborted).toBe(true);
  });

  it("answers acp_auth_unsupported when the client has no authenticate, for either type", async () => {
    for (const methodId of ["key", "login"]) {
      await expect(
        authenticateOn(context({}), { methodId }),
      ).rejects.toMatchObject({ code: "acp_auth_unsupported" });
    }
  });

  it("refuses a method the agent did not declare", async () => {
    await expect(
      authenticateOn(context({ authenticate: async () => ({}) }), {
        methodId: "nope",
      }),
    ).rejects.toMatchObject({ code: "acp_auth_failed" });
  });
});

describe("logoutOn", () => {
  it("signs out when both sides can", async () => {
    const logout = vi.fn().mockResolvedValue({});
    await logoutOn(context({ logout }, capabilities({ logout: true })));
    expect(logout).toHaveBeenCalled();
  });

  it("answers acp_auth_unsupported otherwise", async () => {
    await expect(
      logoutOn(context({}, capabilities({ logout: true }))),
    ).rejects.toMatchObject({ code: "acp_auth_unsupported" });
    await expect(
      logoutOn(context({ logout: async () => ({}) }, capabilities())),
    ).rejects.toMatchObject({ code: "acp_auth_unsupported" });
  });
});

/* ------------------------- 真 core、假 Agent（旧客户端） ------------------------- */

let open: AcpCore | undefined;
afterEach(async () => {
  await open?.stop();
  open = undefined;
  delete (AcpClient.prototype as unknown as Record<string, unknown>)
    .authenticate;
});

async function createFailing(core: AcpCore) {
  const nodeId = await core.node();
  return core.core.call("POST", "/api/acp/sessions", {
    workspaceId: core.workspaceId,
    nodeId,
    cwd: core.core.directory,
    agentId: FAKE_AGENT,
  });
}

describe("the start failure and the auth routes (0.11 client)", () => {
  it("answers acp_auth_required with the declared methods, unsupported on this client", async () => {
    open = await acpCore({ authRequired: true });
    const created = await createFailing(open);
    expect(created.status, JSON.stringify(created.body)).toBe(409);
    expect(created.body).toMatchObject({
      code: "acp_auth_required",
      details: {
        authMethods: [
          {
            id: "login",
            name: "Log in",
            type: "terminal",
            supported: false,
          },
        ],
      },
    });
    // 登录命令的参数不上线。
    expect(JSON.stringify(created.body)).not.toContain("--login");
  });

  it("the auth routes answer acp_auth_unsupported while the client lacks the functions", async () => {
    open = await acpCore({ authRequired: true });
    const body = {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
    };
    const signIn = await open.core.call("POST", "/api/acp/auth/authenticate", {
      ...body,
      methodId: "login",
    });
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(409);
    expect(signIn.body).toMatchObject({ code: "acp_auth_unsupported" });
    const signOut = await open.core.call("POST", "/api/acp/auth/logout", body);
    expect(signOut.status).toBe(409);
    expect(signOut.body).toMatchObject({ code: "acp_auth_unsupported" });
  });

  it("validates the request", async () => {
    open = await acpCore({ authRequired: true });
    const missing = await open.core.call("POST", "/api/acp/auth/authenticate", {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
    });
    expect(missing.status).toBe(400);
    const nowhere = await open.core.call("POST", "/api/acp/auth/authenticate", {
      workspaceId: "nope",
      agentId: FAKE_AGENT,
      methodId: "login",
    });
    expect(nowhere.status).toBe(404);
  });

  it("with an authenticate-capable client the terminal method runs on the host and a retry then works", async () => {
    // 模拟新版客户端：原型上有 authenticate（特性检测按它判）。
    (AcpClient.prototype as unknown as AcpAuthClient).authenticate =
      async () => ({});
    expect(acpClientFeatures().auth).toBe(true);
    open = await acpCore({ authRequired: true });
    const created = await createFailing(open);
    expect(created.body).toMatchObject({
      details: { authMethods: [{ id: "login", supported: true }] },
    });
    // 假 Agent 跑 `--login`：stdin 没有输入就退出，码 0。
    const signedIn = await open.core.call(
      "POST",
      "/api/acp/auth/authenticate",
      {
        workspaceId: open.workspaceId,
        agentId: FAKE_AGENT,
        methodId: "login",
      },
    );
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(204);
  });
});

describe("a real adapter process", () => {
  it("lists the method as the agent declared it", async () => {
    const host = await startAcp({
      program: process.execPath,
      args: [fakeAcpAgentPath(), "--auth-required"],
      cwd: tmpdir(),
    }).catch((error: unknown) => error);
    expect(host).toBeInstanceOf(AcpError);
    expect(host).toMatchObject({
      code: "acp_auth_required",
      details: { authMethods: [{ id: "login", type: "terminal" }] },
    });
  });
});

describe("the RPC door carries the methods too", () => {
  it("acp.createSession's failure has details.authMethods", async () => {
    open = await acpCore({ authRequired: true });
    const core = open.core;
    installContract(core.server, {
      validateOutput: true,
      platform: core.platform,
    });
    const listener = core.server.createListener();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    try {
      const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      const nodeId = await open.node();
      const response = await fetch(`${base}/api/rpc/acp/createSession`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            workspaceId: open.workspaceId,
            nodeId,
            cwd: core.directory,
            agentId: FAKE_AGENT,
          },
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(409);
      expect(body).toMatchObject({
        code: "acp_auth_required",
        details: { authMethods: [{ id: "login", type: "terminal" }] },
      });
    } finally {
      await core.server.close();
    }
  });
});
