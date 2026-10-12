import { describe, expect, it } from "vitest";
import type { TerminalBackend, TerminalSpec } from "../backend";
import type { AskpassService } from "./askpass";
import { SshBackend } from "./backend";

/**
 * SSH 装饰器的工作目录（G5-07）：工作空间就在这台 SSH 主机上时，spec 的 `cwd`
 * 是那台主机上的路径——远端先 `cd` 进去，本机的 `ssh` 从家目录起；别的 SSH
 * 终端照旧。
 */

const HOST = { id: "box", name: "Box", host: "example.com", user: "ada" };

function backend(
  options: {
    executionHost?: (workspaceId: string) => string | undefined;
    remote?: readonly (readonly [string, string])[];
  } = {},
): SshBackend {
  const askpass = {
    start: async () => {},
    childEnvironment: () => [],
  } as unknown as AskpassService;
  return new SshBackend({
    dataDir: "/tmp/armadra-ssh-backend",
    inner: {} as TerminalBackend,
    hosts: (id) => (id === HOST.id ? HOST : undefined),
    askpass,
    ...(options.remote === undefined
      ? {}
      : { remote: async () => options.remote }),
    ...(options.executionHost === undefined
      ? {}
      : { executionHost: options.executionHost }),
    localDirectory: () => "/home/local",
  });
}

function spec(workspaceId: string, cwd: string) {
  return {
    sessionKey: "s" as TerminalSpec["sessionKey"],
    workspaceId,
    generation: 1,
    cwd,
    shell: "/bin/zsh",
    args: [],
    env: [],
    size: { cols: 80, rows: 24 },
    sshHostId: HOST.id,
  };
}

describe("SshBackend.decorate", () => {
  it("enters the remote directory when the workspace lives on that host", async () => {
    const decorated = await backend({
      executionHost: (id) => (id === "ws-remote" ? HOST.id : undefined),
      remote: [["ARMADRA_SHIMS", "/srv/i/shims"]],
    }).decorate(spec("ws-remote", "/srv/project/src"));
    expect(decorated.cwd).toBe("/home/local");
    const remote = decorated.args.at(-1) as string;
    expect(remote).toBe(
      "env ARMADRA_SHIMS='/srv/i/shims' ARMADRA_REMOTE_CWD='/srv/project/src' /bin/sh -c " +
        `'cd -- "$ARMADRA_REMOTE_CWD" || exit 1; unset ARMADRA_REMOTE_CWD; ` +
        `PATH="$ARMADRA_SHIMS:$PATH"; export PATH; exec "\${SHELL:-/bin/sh}" -l'`,
    );
  });

  it("still enters the directory without an injection, leaving PATH alone", async () => {
    const decorated = await backend({
      executionHost: () => HOST.id,
    }).decorate(spec("ws-remote", "/srv/project"));
    expect(decorated.args.at(-1)).toBe(
      "env ARMADRA_REMOTE_CWD='/srv/project' /bin/sh -c " +
        `'cd -- "$ARMADRA_REMOTE_CWD" || exit 1; unset ARMADRA_REMOTE_CWD; exec "\${SHELL:-/bin/sh}" -l'`,
    );
  });

  it("keeps a local workspace's SSH terminal as it was", async () => {
    const plain = await backend({ executionHost: () => undefined }).decorate(
      spec("ws-local", "/Users/me/project"),
    );
    expect(plain.cwd).toBe("/Users/me/project");
    expect(plain.args.at(-1)).toBe("ada@example.com");
    const other = await backend({ executionHost: () => "elsewhere" }).decorate(
      spec("ws-local", "/Users/me/project"),
    );
    expect(other.cwd).toBe("/Users/me/project");
  });

  it("refuses a directory the remote shell would interpret", async () => {
    await expect(
      backend({ executionHost: () => HOST.id }).decorate(
        spec("ws-remote", "/srv/it's"),
      ),
    ).rejects.toThrow();
  });
});
