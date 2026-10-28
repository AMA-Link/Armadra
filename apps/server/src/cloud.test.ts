import { describe, expect, it } from "vitest";
import type { OutboundRequest } from "../../desktop/src/core/sources/http-client";
import { parseCommandLine } from "./cli";
import {
  CloudCliError,
  type LocalCore,
  PASSWORD_ENV,
  TOKEN_ENV,
  parseExpires,
} from "./cloud";
import { main } from "./main";

const ISSUER = "https://relay.example.com";
const FINGERPRINT = "ab".repeat(32);
const TOKEN = "registration-token-secret";
const PASSWORD = "correct horse battery staple";
const ACCESS = "relay-access-token-secret";
const ASSERTION = "signed-assertion-secret";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** 假的本机 core：按路径答，记下每次调用。 */
function fakeCore(
  options: {
    registered?: boolean;
    alreadyRegistered?: boolean;
    alreadyBound?: boolean;
    kind?: "personal" | "saas";
    /** SaaS 设备码轮询依次答的状态（最后一个之后一直答它）。 */
    polls?: string[];
  } = {},
) {
  const calls: Call[] = [];
  let registered = options.registered ?? false;
  const kind = options.kind ?? "personal";
  const polls = [...(options.polls ?? ["ready"])];
  const row = () => ({
    serviceId: "s".repeat(32),
    kind,
    issuer: ISSUER,
    fingerprint: kind === "saas" ? "" : FINGERPRINT,
    registered,
  });
  const core: LocalCore = {
    async call(method, path, body) {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/sources") {
        return { remotes: [row()] };
      }
      if (method === "POST" && path === "/api/sources/remotes") {
        return {
          remote: row(),
          next:
            kind === "saas"
              ? {
                  deviceCode: {
                    userCode: "BCDF-GHJK",
                    verificationUrl: `${ISSUER}/device`,
                    expiresAtMs: 10_000_000,
                    intervalMs: 5_000,
                  },
                }
              : "ready",
        };
      }
      if (
        method === "POST" &&
        path === `/api/sources/remotes/${"s".repeat(32)}/poll`
      ) {
        const status = polls.length > 1 ? polls.shift() : polls[0];
        if (status === "rate_limited") {
          throw new CloudCliError("rate_limited", "太快");
        }
        return { status };
      }
      if (
        method === "GET" &&
        path === `/api/sources/remotes/${"s".repeat(32)}/spaces`
      ) {
        return {
          spaces: [
            { kind: "personal", plan: "free" },
            {
              kind: "team",
              teamId: "team_1",
              slug: "rd",
              name: "研发",
              role: "owner",
              plan: "team",
            },
          ],
        };
      }
      if (
        method === "POST" &&
        path === `/api/sources/remotes/${"s".repeat(32)}/register`
      ) {
        if (registered) {
          throw new CloudCliError("cloud_already_registered", "已经登记");
        }
        registered = true;
        return { remote: row(), sourceId: "h".repeat(32) };
      }
      if (
        method === "POST" &&
        path === `/api/sources/remotes/${"s".repeat(32)}/links`
      ) {
        return {
          url: `${ISSUER}/j/L2#sekret.${"i".repeat(32)}.secret.ABCDEFGHIJKLMNOP`,
          link: {
            linkId: "L2",
            expiresAtMs: 2_000_000_000_000,
            role: "viewer",
          },
        };
      }
      if (path.endsWith("/session")) return { accessToken: ACCESS };
      if (method === "POST" && path === "/api/identity/cloud/register") {
        if (options.alreadyRegistered === true) {
          throw new CloudCliError("cloud_already_registered", "已经登记");
        }
        registered = true;
        return { issuer: ISSUER, tunnel: { state: "connecting", node: null } };
      }
      if (method === "POST" && path === "/api/identity/cloud/bind") {
        if (options.alreadyBound === true) {
          throw new CloudCliError("conflict", "已经关联");
        }
        return { bound: true };
      }
      if (method === "GET" && path === "/api/identity/cloud") {
        return {
          sourceId: "h".repeat(32),
          registrations: registered
            ? [
                {
                  issuer: ISSUER,
                  mode: "personal",
                  tunnel: {
                    state: "ready",
                    node: "wss://relay.example.com/t/v1",
                  },
                },
              ]
            : [],
        };
      }
      if (
        method === "DELETE" &&
        path.startsWith("/api/identity/cloud/register")
      ) {
        return {};
      }
      if (method === "GET" && path === "/api/identity/cloud/relay-pending") {
        return {
          pending: [
            { issuer: ISSUER, revokedAtMs: 1, code: "source_unauthorized" },
          ],
        };
      }
      if (method === "POST" && path === "/api/identity/invitations") {
        return {
          invitationId: "i".repeat(32),
          token: `${"i".repeat(32)}.secret`,
          expiresAtMs: 2_000_000_000_000,
        };
      }
      if (
        method === "DELETE" &&
        path.startsWith("/api/identity/invitations/")
      ) {
        return { revoked: true };
      }
      throw new Error(`未预期的调用 ${method} ${path}`);
    },
  };
  return { core, calls };
}

function harness(
  core: LocalCore,
  extra: {
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    prompt?: string;
    link?: { status: number; body: unknown };
    mode?: "personal" | "saas";
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const relay: OutboundRequest[] = [];
  const clock = { now: 1_000 };
  const io = {
    stdout: (line: string) => void out.push(line),
    stderr: (line: string) => void err.push(line),
    env: extra.env ?? {},
    moduleDir: "/nowhere",
    ...(extra.stdin === undefined
      ? {}
      : { stdin: async () => extra.stdin as string }),
    ...(extra.prompt === undefined
      ? {}
      : { prompt: async () => extra.prompt as string }),
    cloud: {
      connect: async () => core,
      now: () => (clock.now += 400),
      wait: async (ms: number) => void (clock.now += ms),
      transport: async (request: OutboundRequest) => {
        if (request.url.endsWith("/.well-known/armadra-platform")) {
          return { status: 200, body: { mode: extra.mode ?? "personal" } };
        }
        relay.push(request);
        if (request.url.endsWith("/v1/sources/registration-tokens")) {
          return {
            status: 200,
            body: { registrationToken: TOKEN, expiresAtMs: 1, issuer: ISSUER },
          };
        }
        if (request.url.endsWith("/assertion")) {
          return { status: 200, body: { assertion: ASSERTION } };
        }
        return (
          extra.link ?? {
            status: 200,
            body: {
              linkId: "L1",
              url: `${ISSUER}/j/L1`,
              secret: "sekret",
              expiresAtMs: 2_000_000_000_000,
            },
          }
        );
      },
    },
  };
  return { io, out, err, relay };
}

describe("cloud 与 invite 的参数解析", () => {
  it("cloud 要一个动作，参数在表里，invite 的 --cloud-link 不带值", () => {
    const parsed = parseCommandLine([
      "cloud",
      "register",
      "--issuer",
      ISSUER,
      "--token-stdin",
    ]);
    expect(parsed).toMatchObject({
      kind: "run",
      command: "cloud",
      positionals: ["register"],
    });
    expect(parseCommandLine(["cloud", "register", "extra"])).toMatchObject({
      kind: "error",
    });
    expect(
      parseCommandLine(["cloud", "register", "--listen", "a:1"]),
    ).toMatchObject({ kind: "error" });
    expect(
      parseCommandLine(["invite", "--cloud-link", "--issuer", ISSUER]),
    ).toMatchObject({
      kind: "run",
      command: "invite",
    });
    expect(parseCommandLine(["invite", "--cloud-link=1"])).toMatchObject({
      kind: "error",
    });
  });

  it("--expires 认 m / h / d", () => {
    expect(parseExpires("30m")).toBe(1_800_000);
    expect(parseExpires("12h")).toBe(43_200_000);
    expect(parseExpires("7d")).toBe(604_800_000);
    for (const bad of ["7", "d", "0d", "7w", "-1d", ""]) {
      expect(parseExpires(bad)).toBeUndefined();
    }
  });
});

describe("cloud register / revoke / status", () => {
  it("register：令牌与指纹交给 core，等隧道 ready，输出里没有令牌", async () => {
    const { core, calls } = fakeCore();
    const { io, out, err } = harness(core, { env: { [TOKEN_ENV]: TOKEN } });
    const code = await main(
      [
        "cloud",
        "register",
        "--issuer",
        ISSUER,
        "--fingerprint",
        FINGERPRINT,
        "--label",
        "box",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/register")?.body,
    ).toEqual({
      issuer: ISSUER,
      registrationToken: TOKEN,
      label: "box",
      fingerprint: FINGERPRINT,
    });
    expect(out.join("")).toContain("已登记");
    expect(out.join("")).toContain("ready");
    expect(out.join("") + err.join("")).not.toContain(TOKEN);
  });

  it("register：--token-stdin 从标准输入读；已登记是幂等的，退出 0", async () => {
    const { core, calls } = fakeCore({ alreadyRegistered: true });
    const { io, out } = harness(core, { stdin: `${TOKEN}\n` });
    expect(
      await main(
        ["cloud", "register", "--issuer", ISSUER, "--token-stdin"],
        io,
      ),
    ).toBe(0);
    expect(out.join("")).toContain("跳过");
    expect(
      (calls[0]?.body as { registrationToken: string }).registrationToken,
    ).toBe(TOKEN);
  });

  it("register：缺令牌或地址是用法错误（2），不去连 core", async () => {
    const { core, calls } = fakeCore();
    const { io, err } = harness(core);
    expect(await main(["cloud", "register", "--issuer", ISSUER], io)).toBe(2);
    expect(await main(["cloud", "register", "--token", TOKEN], io)).toBe(2);
    expect(
      await main(
        [
          "cloud",
          "register",
          "--issuer",
          ISSUER,
          "--token",
          TOKEN,
          "--fingerprint",
          "zz",
        ],
        io,
      ),
    ).toBe(2);
    expect(calls).toEqual([]);
    expect(err.join("")).not.toContain(TOKEN);
  });

  it("revoke 与 status（含 --output json）", async () => {
    const { core, calls } = fakeCore({ registered: true });
    const { io, out } = harness(core);
    expect(await main(["cloud", "revoke", "--issuer", ISSUER], io)).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: `/api/identity/cloud/register?issuer=${encodeURIComponent(ISSUER)}`,
    });
    // 服务器壳没有远程服务 owner 的会话：如实说中继侧待清理（契约 §31.4）。
    expect(out.join("")).toContain("中继侧待清理（source_unauthorized）");
    out.length = 0;
    expect(
      await main(
        ["cloud", "revoke", "--issuer", ISSUER, "--output", "json"],
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      command: "cloud revoke",
      relayPending: "source_unauthorized",
    });
    out.length = 0;
    expect(await main(["cloud", "status"], io)).toBe(0);
    expect(out.join("")).toContain(`${ISSUER}（personal）隧道 ready`);
    out.length = 0;
    expect(await main(["cloud", "status", "--output", "json"], io)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      command: "cloud status",
      registrations: [{ issuer: ISSUER }],
    });
  });

  it("core 没起来：退出 69（容器入口据此重试）", async () => {
    const { io, err } = harness(fakeCore().core, {
      env: { [TOKEN_ENV]: TOKEN },
    });
    io.cloud.connect = async () => {
      throw new CloudCliError("host_unavailable", "连不上运行中的服务器壳");
    };
    expect(await main(["cloud", "register", "--issuer", ISSUER], io)).toBe(69);
    expect(err.join("")).toContain("连不上");
  });
});

describe("cloud login", () => {
  it("口令经标准输入：core 登录并钉扎，向中继要注册令牌，再登记；口令与令牌不出现在输出", async () => {
    const { core, calls } = fakeCore();
    const { io, out, err, relay } = harness(core, { stdin: `${PASSWORD}\n` });
    const code = await main(
      [
        "cloud",
        "login",
        "--issuer",
        ISSUER,
        "--account",
        "dev",
        "--fingerprint",
        FINGERPRINT,
        "--password-stdin",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(
      calls.find((call) => call.path === "/api/sources/remotes")?.body,
    ).toMatchObject({
      kind: "personal",
      issuer: ISSUER,
      account: "dev",
      password: PASSWORD,
      fingerprint: FINGERPRINT,
    });
    expect(relay).toHaveLength(2);
    expect(relay[0]).toMatchObject({
      method: "POST",
      url: `${ISSUER}/v1/sources/registration-tokens`,
      fingerprint: FINGERPRINT,
      headers: { authorization: `Bearer ${ACCESS}` },
    });
    // #377：登记后为本机取断言，交给 core 把这个账号映射到本机 owner。
    expect(relay[1]).toMatchObject({
      method: "POST",
      url: `${ISSUER}/v1/sources/${"h".repeat(32)}/assertion`,
      headers: { authorization: `Bearer ${ACCESS}` },
    });
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/bind")?.body,
    ).toEqual({ assertion: ASSERTION });
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/register")?.body,
    ).toMatchObject({
      issuer: ISSUER,
      registrationToken: TOKEN,
    });
    const all = out.join("") + err.join("");
    for (const secret of [PASSWORD, TOKEN, ACCESS, ASSERTION])
      expect(all).not.toContain(secret);
  });

  it("早已登记或账号已关联都不算失败，仍会补做关联；失败的绑定如实报错", async () => {
    const again = fakeCore({ alreadyRegistered: true, alreadyBound: true });
    const first = harness(again.core, { stdin: `${PASSWORD}\n` });
    expect(
      await main(
        [
          "cloud",
          "login",
          "--issuer",
          ISSUER,
          "--account",
          "dev",
          "--password-stdin",
        ],
        first.io,
      ),
    ).toBe(0);
    expect(
      again.calls.some((call) => call.path === "/api/identity/cloud/bind"),
    ).toBe(true);
    expect(first.out.join("")).toContain("主人");

    const noAssertion = fakeCore();
    const broken = harness(noAssertion.core, { stdin: `${PASSWORD}\n` });
    const transport = broken.io.cloud.transport;
    broken.io.cloud.transport = async (request: OutboundRequest) =>
      request.url.endsWith("/assertion")
        ? { status: 200, body: {} }
        : transport(request);
    expect(
      await main(
        [
          "cloud",
          "login",
          "--issuer",
          ISSUER,
          "--account",
          "dev",
          "--password-stdin",
        ],
        broken.io,
      ),
    ).toBe(1);
    expect(
      noAssertion.calls.some(
        (call) => call.path === "/api/identity/cloud/bind",
      ),
    ).toBe(false);
  });

  it("口令可来自环境变量或终端提示；都没有是用法错误", async () => {
    const env = harness(fakeCore().core, { env: { [PASSWORD_ENV]: PASSWORD } });
    expect(
      await main(
        ["cloud", "login", "--issuer", ISSUER, "--account", "dev"],
        env.io,
      ),
    ).toBe(0);
    const prompted = harness(fakeCore().core, { prompt: PASSWORD });
    expect(
      await main(
        ["cloud", "login", "--issuer", ISSUER, "--account", "dev"],
        prompted.io,
      ),
    ).toBe(0);
    const none = harness(fakeCore().core);
    expect(
      await main(
        ["cloud", "login", "--issuer", ISSUER, "--account", "dev"],
        none.io,
      ),
    ).toBe(2);
  });
});

describe("invite --cloud-link", () => {
  const base = [
    "invite",
    "--cloud-link",
    "--issuer",
    ISSUER,
    "--workspace",
    "w1",
  ];
  const linkCall = (calls: Call[]) =>
    calls.find(
      (call) => call.path === `/api/sources/remotes/${"s".repeat(32)}/links`,
    );

  it("工作空间：改调 core 的 shareLinkCreate（maxUses、ttl），打印三段片段的链接；不再自己签邀请", async () => {
    const { core, calls } = fakeCore({ registered: true });
    const { io, out, relay } = harness(core);
    expect(
      await main(
        [...base, "--role", "editor", "--max-uses", "5", "--expires", "7d"],
        io,
      ),
    ).toBe(0);
    expect(linkCall(calls)?.body).toEqual({
      target: "workspace",
      workspaceId: "w1",
      role: "editor",
      ttlMs: 604_800_000,
      maxUses: 5,
      label: "Armadra",
    });
    expect(
      calls.some((call) => call.path === "/api/identity/invitations"),
    ).toBe(false);
    expect(relay).toEqual([]);
    expect(out.join("").trim()).toBe(
      `${ISSUER}/j/L2#sekret.${"i".repeat(32)}.secret.ABCDEFGHIJKLMNOP`,
    );
  });

  it("--host 整台：Armadra 云同一条；缺省一次性、7 天", async () => {
    const { core, calls } = fakeCore({ registered: true, kind: "saas" });
    const { io, out } = harness(core, { mode: "saas" });
    expect(
      await main(
        [
          "invite",
          "--cloud-link",
          "--issuer",
          ISSUER,
          "--host",
          "--role",
          "viewer",
          "--output",
          "json",
        ],
        io,
      ),
    ).toBe(0);
    expect(linkCall(calls)?.body).toEqual({
      target: "host",
      workspaceId: "",
      role: "viewer",
      ttlMs: 7 * 86_400_000,
      maxUses: 1,
      label: "Armadra",
    });
    const document = JSON.parse(out.join("")) as { url: string };
    // 片段三段之外还带身份指纹前缀：秘密.邀请令牌（含点）.指纹。
    expect(document.url.split("#")[1]?.split(".").at(-1)).toBe(
      "ABCDEFGHIJKLMNOP",
    );
  });

  it("Armadra 云上 --group 明确报错（用法 2），不建任何东西", async () => {
    const { core, calls } = fakeCore({ registered: true, kind: "saas" });
    const { io, err } = harness(core, { mode: "saas" });
    expect(
      await main(
        ["invite", "--cloud-link", "--issuer", ISSUER, "--group", "g1"],
        io,
      ),
    ).toBe(2);
    expect(err.join("")).toContain("Armadra 云的链接不支持组");
    expect(calls.map((call) => call.path)).toEqual(["/api/sources"]);
  });

  it("个人中转的 --group 仍走旧路径：本机签组邀请，中继出链接；中继拒绝时撤掉刚建的邀请", async () => {
    const { core, calls } = fakeCore({ registered: true });
    const { io, out, relay } = harness(core);
    const group = [
      "invite",
      "--cloud-link",
      "--issuer",
      ISSUER,
      "--group",
      "g1",
    ];
    expect(await main([...group, "--max-uses", "3"], io)).toBe(0);
    expect(
      calls.find((call) => call.path === "/api/identity/invitations")?.body,
    ).toEqual({ role: "viewer", targetGroupId: "g1", maxUses: 3 });
    expect(relay[0]).toMatchObject({
      url: `${ISSUER}/v1/links`,
      body: {
        kind: "source_invite",
        sourceId: "h".repeat(32),
        invitationId: "i".repeat(32),
      },
    });
    expect(out.join("").trim()).toBe(
      `${ISSUER}/j/L1#sekret.${"i".repeat(32)}.secret`,
    );

    const refused = fakeCore({ registered: true });
    const third = harness(refused.core, {
      link: {
        status: 403,
        body: { code: "source_access_denied", message: "没有权限" },
      },
    });
    expect(await main(group, third.io)).toBe(1);
    expect(
      refused.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path === `/api/identity/invitations/${"i".repeat(32)}`,
      ),
    ).toBe(true);
  });

  it("没登记、参数不对都不建链接", async () => {
    const unregistered = fakeCore({ registered: false });
    const first = harness(unregistered.core);
    expect(await main(base, first.io)).toBe(1);
    expect(linkCall(unregistered.calls)).toBeUndefined();

    const bad = fakeCore({ registered: true });
    const second = harness(bad.core);
    expect(
      await main(
        ["invite", "--issuer", ISSUER, "--workspace", "w1"],
        second.io,
      ),
    ).toBe(2);
    expect(await main([...base, "--group", "g1"], second.io)).toBe(2);
    expect(await main([...base, "--host"], second.io)).toBe(2);
    expect(
      await main(["invite", "--cloud-link", "--issuer", ISSUER], second.io),
    ).toBe(2);
    expect(await main([...base, "--max-uses", "0"], second.io)).toBe(2);
    expect(await main([...base, "--expires", "soon"], second.io)).toBe(2);
    expect(bad.calls).toEqual([]);
  });
});

describe("cloud login（Armadra 云，设计 §4.4）", () => {
  const login = ["cloud", "login", "--issuer", ISSUER];

  it("未登记：设备码只打到标准错误，批准后按 --space 登记并关联主人；输出里没有令牌与断言", async () => {
    const { core, calls } = fakeCore({
      kind: "saas",
      polls: ["pending", "rate_limited", "ready"],
    });
    const { io, out, err, relay } = harness(core, { mode: "saas" });
    expect(await main([...login, "--space", "rd", "--label", "box"], io)).toBe(
      0,
    );
    expect(
      calls.find((call) => call.path === "/api/sources/remotes")?.body,
    ).toEqual({ kind: "saas", issuer: ISSUER, label: "box" });
    expect(err.join("")).toContain("BCDF-GHJK");
    expect(err.join("")).toContain(`${ISSUER}/device`);
    expect(out.join("")).not.toContain("BCDF-GHJK");
    expect(calls.filter((call) => call.path.endsWith("/poll")).length).toBe(3);
    expect(calls.find((call) => call.path.endsWith("/register"))?.body).toEqual(
      { space: { kind: "team", teamId: "team_1" }, label: "box" },
    );
    expect(relay.at(-1)).toMatchObject({
      method: "POST",
      url: `${ISSUER}/v1/sources/${"h".repeat(32)}/assertion`,
    });
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/bind")?.body,
    ).toEqual({ assertion: ASSERTION });
    expect(out.join("")).toContain("已登录");
    expect(out.join("")).toContain("本机主人");
    const all = out.join("") + err.join("");
    for (const secret of [ACCESS, ASSERTION]) expect(all).not.toContain(secret);
  });

  it("已用 --token 登记：只绑定——不再登记，取断言交给 core bind", async () => {
    const { core, calls } = fakeCore({ kind: "saas", registered: true });
    const { io, out } = harness(core, { mode: "saas" });
    expect(await main([...login, "--output", "json"], io)).toBe(0);
    expect(calls.some((call) => call.path.endsWith("/register"))).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/spaces"))).toBe(false);
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/bind")?.body,
    ).toEqual({ assertion: ASSERTION });
    expect(JSON.parse(out.join(""))).toMatchObject({
      command: "cloud login",
      mode: "saas",
      registered: false,
      bound: true,
    });
  });

  it("映射已属本机另一个人（不是自动成员）：如实说没改动，退出 0", async () => {
    const { core } = fakeCore({
      kind: "saas",
      registered: true,
      alreadyBound: true,
    });
    const { io, out } = harness(core, { mode: "saas" });
    expect(await main(login, io)).toBe(0);
    expect(out.join("")).toContain("另一个人");
  });

  it("拒绝或过期：退出 1，不登记；--account 与 --space 用错是用法错误", async () => {
    for (const status of ["denied", "expired"]) {
      const { core, calls } = fakeCore({ kind: "saas", polls: [status] });
      const { io } = harness(core, { mode: "saas" });
      expect(await main(login, io)).toBe(1);
      expect(calls.some((call) => call.path.endsWith("/register"))).toBe(false);
    }
    const saas = harness(fakeCore({ kind: "saas" }).core, { mode: "saas" });
    expect(await main([...login, "--account", "dev"], saas.io)).toBe(2);
    const personal = harness(fakeCore().core, {
      env: { [PASSWORD_ENV]: PASSWORD },
    });
    expect(
      await main([...login, "--account", "dev", "--space", "rd"], personal.io),
    ).toBe(2);
    const unknown = harness(fakeCore({ kind: "saas" }).core, { mode: "saas" });
    expect(await main([...login, "--space", "nope"], unknown.io)).toBe(2);
  });

  it("参数解析认 --space 与 --host", () => {
    expect(
      parseCommandLine(["cloud", "login", "--issuer", ISSUER, "--space", "rd"]),
    ).toMatchObject({ kind: "run" });
    expect(
      parseCommandLine([
        "invite",
        "--cloud-link",
        "--issuer",
        ISSUER,
        "--host",
      ]),
    ).toMatchObject({ kind: "run" });
    expect(
      parseCommandLine(["invite", "--cloud-link", "--host=1"]),
    ).toMatchObject({ kind: "error" });
  });
});
