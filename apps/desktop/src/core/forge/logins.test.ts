/**
 * 复用本机登录（契约 §111.6）：gh / glab / tea / git credential 四档与顺序、按主机、
 * 短缓存、关开关即清、不弹框的环境。外部命令与文件读取全是 mock：不起真的 gh /
 * glab / git，也不读真 HOME。
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandOptions, CommandRunner } from "./exec";
import { LocalLogins, parseTeaLogins } from "./logins";

/** 拼法与实现一致：Windows 上是反斜杠。 */
const TEA_PATH = join("/home/test", ".config", "tea", "config.yml");

const TOKEN = "ghp_ExampleTokenValue0123456789";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: CommandOptions;
}

function rig(
  answers: (call: Call) => { ok: boolean; stdout?: string },
  extra: {
    enabled?: () => boolean;
    files?: Record<string, string>;
    now?: () => number;
  } = {},
) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const run: CommandRunner = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const answer = answers(call);
    return { ok: answer.ok, stdout: answer.stdout ?? "" };
  };
  const logins = new LocalLogins({
    enabled: extra.enabled ?? (() => true),
    run,
    readFile: async (path) => {
      reads.push(path);
      return extra.files?.[path];
    },
    home: () => "/home/test",
    env: {},
    platform: "linux",
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
  return { logins, calls, reads };
}

describe("gh：每个主机分开", () => {
  it("gh auth token --hostname <host>；github.com 与企业版各一个令牌", async () => {
    const { logins, calls } = rig((call) => ({
      ok: true,
      stdout: `${call.args[3] === "github.com" ? "ghp_publicToken0001" : "ghp_enterpriseToken0002"}\n`,
    }));
    expect(await logins.resolve("github.com", "github")).toEqual({
      token: "ghp_publicToken0001",
      source: "ghCli",
    });
    expect(await logins.resolve("ghe.corp.test", "github")).toEqual({
      token: "ghp_enterpriseToken0002",
      source: "ghCli",
    });
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com"],
      ["gh", "auth", "token", "--hostname", "ghe.corp.test"],
    ]);
  });
});

describe("glab", () => {
  it("glab config get token --host <host>", async () => {
    const { logins, calls } = rig(() => ({
      ok: true,
      stdout: "glpat-abcDEF123456\n",
    }));
    expect(await logins.resolve("gitlab.corp.test", "gitlab")).toEqual({
      token: "glpat-abcDEF123456",
      source: "glab",
    });
    expect(calls[0]).toMatchObject({
      file: "glab",
      args: ["config", "get", "token", "--host", "gitlab.corp.test"],
    });
  });
});

const TEA = `logins:
  - name: gitea.com
    url: https://gitea.com
    token: tokenForGiteaCom
    default: true
  - name: corp
    url: 'https://git.corp.test:3000/'
    token: "tokenForCorp"
    ssh_host: git.corp.test
preferences:
  editor: false
`;

describe("tea：只读配置文件", () => {
  it("parseTeaLogins 取 url 与 token", () => {
    expect(parseTeaLogins(TEA)).toEqual([
      { url: "https://gitea.com", token: "tokenForGiteaCom" },
      { url: "https://git.corp.test:3000/", token: "tokenForCorp" },
    ]);
    expect(parseTeaLogins("nothing: here")).toEqual([]);
  });

  it("按主机匹配（忽略端口），位置是 ~/.config/tea/config.yml，不起命令", async () => {
    const path = TEA_PATH;
    const { logins, calls, reads } = rig(() => ({ ok: false }), {
      files: { [path]: TEA },
    });
    expect(await logins.resolve("git.corp.test", "gitea")).toEqual({
      token: "tokenForCorp",
      source: "tea",
    });
    expect(reads).toEqual([path]);
    expect(calls.filter((call) => call.file === "tea")).toEqual([]);
  });

  it("没有这个主机的登录就落到 git credential", async () => {
    const { logins, calls } = rig(
      (call) =>
        call.file === "git"
          ? {
              ok: true,
              stdout:
                "protocol=https\nhost=other.test\nusername=u\npassword=fromGitHelper1\n",
            }
          : { ok: false },
      { files: { [TEA_PATH]: TEA } },
    );
    expect(await logins.resolve("other.test", "gitea")).toEqual({
      token: "fromGitHelper1",
      source: "gitCredential",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("git credential fill：最后一档", () => {
  it("只限 https、不弹框；stdin 只有协议与主机", async () => {
    const { logins, calls } = rig((call) =>
      call.file === "gh"
        ? { ok: false }
        : {
            ok: true,
            stdout:
              "host=ghe.corp.test\nusername=x\npassword=helperToken0001\n",
          },
    );
    expect(await logins.resolve("ghe.corp.test", "github")).toEqual({
      token: "helperToken0001",
      source: "gitCredential",
    });
    const fill = calls.find((call) => call.file === "git");
    expect(fill?.args).toEqual(["credential", "fill"]);
    expect(fill?.options.input).toBe("protocol=https\nhost=ghe.corp.test\n\n");
    expect(fill?.options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    });
  });

  it("助手答的是别的主机：不用；没有 password：不用", async () => {
    const other = rig((call) =>
      call.file === "git"
        ? { ok: true, stdout: "host=evil.test\npassword=stolenToken0001\n" }
        : { ok: false },
    );
    expect(await other.logins.resolve("ghe.corp.test", "github")).toBeNull();
    const empty = rig((call) =>
      call.file === "git"
        ? { ok: true, stdout: "host=ghe.corp.test\nusername=x\n" }
        : { ok: false },
    );
    expect(await empty.logins.resolve("ghe.corp.test", "github")).toBeNull();
  });

  it("gh 有令牌时不再问 git credential", async () => {
    const { logins, calls } = rig(() => ({ ok: true, stdout: `${TOKEN}\n` }));
    await logins.resolve("github.com", "github");
    expect(calls.map((call) => call.file)).toEqual(["gh"]);
  });
});

describe("缓存、开关与不合格的输出", () => {
  it("60 秒内不再起命令；没认到的 10 秒；forget 立即清", async () => {
    let at = 0;
    const { logins, calls } = rig(() => ({ ok: true, stdout: `${TOKEN}\n` }), {
      now: () => at,
    });
    await logins.resolve("github.com", "github");
    at += 59_000;
    await logins.resolve("github.com", "github");
    expect(calls).toHaveLength(1);
    expect(logins.peek("github.com", "github")?.token).toBe(TOKEN);
    at += 2_000;
    expect(logins.peek("github.com", "github")).toBeUndefined();
    await logins.resolve("github.com", "github");
    expect(calls).toHaveLength(2);
    logins.forget("github.com");
    expect(logins.peek("github.com", "github")).toBeUndefined();

    const none = rig(() => ({ ok: false }), { now: () => at });
    expect(await none.logins.resolve("a.test", "github")).toBeNull();
    const before = none.calls.length;
    await none.logins.resolve("a.test", "github");
    expect(none.calls).toHaveLength(before);
    at += 11_000;
    await none.logins.resolve("a.test", "github");
    expect(none.calls.length).toBeGreaterThan(before);
  });

  it("开关关着：不起命令、不读文件、peek 也看不到缓存", async () => {
    let on = true;
    const { logins, calls, reads } = rig(
      () => ({ ok: true, stdout: `${TOKEN}\n` }),
      {
        enabled: () => on,
      },
    );
    await logins.resolve("github.com", "github");
    expect(logins.peek("github.com", "github")).not.toBeUndefined();
    on = false;
    expect(logins.peek("github.com", "github")).toBeUndefined();
    expect(await logins.resolve("github.com", "github")).toBeNull();
    expect(await logins.resolve("a.test", "gitea")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  it("读的过程中开关被关：不留令牌", async () => {
    let on = true;
    const { logins } = rig(
      () => {
        on = false;
        return { ok: true, stdout: `${TOKEN}\n` };
      },
      { enabled: () => on },
    );
    expect(await logins.resolve("github.com", "github")).toBeNull();
    on = true;
    expect(logins.peek("github.com", "github")).toBeUndefined();
  });

  it("多行、带空白、超长的输出都不算令牌；主机名不合格不起命令；命令抛错不外传", async () => {
    const bad = rig(() => ({ ok: true, stdout: "line one\nline two\n" }));
    expect(await bad.logins.resolve("github.com", "github")).toBeNull();
    const spaced = rig(() => ({ ok: true, stdout: "not a token" }));
    expect(await spaced.logins.resolve("github.com", "github")).toBeNull();
    const none = rig(() => ({ ok: true, stdout: TOKEN }));
    expect(await none.logins.resolve("bad host;rm", "github")).toBeNull();
    expect(none.calls).toEqual([]);
    const boom = new LocalLogins({
      enabled: () => true,
      run: async () => {
        throw new Error("spawn gh ENOENT");
      },
      readFile: async () => undefined,
    });
    expect(await boom.resolve("github.com", "github")).toBeNull();
  });
});
