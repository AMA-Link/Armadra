import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AskpassService } from "../../core/terminal/ssh/askpass";
import { channelKey } from "../../core/private-pipe/handshake";
import { ASKPASS_LABEL } from "../../core/private-pipe/labels";
import { guardServer } from "../../core/private-pipe/server";
import { tempDir } from "../../core/testing/temp-dir";
import {
  HOST_ENV,
  KEY_FILE_ENV,
  MODE_ENV,
  SOCKET_ENV,
  TOKEN_ENV,
  askpassMode,
  run,
} from "./askpass";

function endpoint(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\armadra-askpass-test-${process.pid}-${randomBytes(4).toString("hex")}`
    : join(mkdtempSync(join(tmpdir(), "armadra-ap-")), "a.sock");
}

function keyFile(root: Buffer): string {
  const file = join(mkdtempSync(join(tmpdir(), "armadra-ap-")), "pipe.key");
  writeFileSync(file, `${root.toString("hex")}\n`);
  return file;
}

describe("the askpass client", () => {
  it("is only the askpass program when the core marked the environment", () => {
    expect(askpassMode({})).toBe(false);
    expect(askpassMode({ [MODE_ENV]: "1" })).toBe(true);
    expect(askpassMode({ [MODE_ENV]: "0" })).toBe(false);
  });

  async function serve(
    root: Buffer,
    reply: (
      headers: Record<string, string | string[] | undefined>,
      body: string,
    ) => { status: number; text: string },
  ) {
    const path = endpoint();
    const seen: {
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }[] = [];
    const server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (chunk: Buffer) => parts.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(parts).toString("utf8");
        seen.push({ headers: request.headers, body });
        const answer = reply(request.headers, body);
        response.writeHead(answer.status, { "content-type": "text/plain" });
        response.end(answer.text);
      });
    });
    guardServer(server, {
      channel: {
        label: ASKPASS_LABEL,
        pipe: path,
        key: channelKey(root, ASKPASS_LABEL),
      },
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return { path, seen, close: () => server.close() };
  }

  it("asks the pipe with the token and prints the answer", async () => {
    const root = randomBytes(32);
    const served = await serve(root, () => ({
      status: 200,
      text: "hunter2\n",
    }));
    try {
      let printed = "";
      const code = await run(["user@host's password: "], {
        env: {
          [SOCKET_ENV]: served.path,
          [TOKEN_ENV]: "one-time-token",
          [HOST_ENV]: "host-1",
          [KEY_FILE_ENV]: keyFile(root),
        },
        stdout: (text) => (printed += text),
      });
      expect(code).toBe(0);
      expect(printed).toBe("hunter2\n");
      expect(served.seen[0]?.body).toBe("user@host's password: ");
      expect(served.seen[0]?.headers.authorization).toBe(
        "Bearer one-time-token",
      );
      expect(served.seen[0]?.headers["x-armadra-host"]).toBe("host-1");
    } finally {
      served.close();
    }
  });

  it("prints nothing and fails when the core refuses", async () => {
    const root = randomBytes(32);
    const served = await serve(root, () => ({ status: 401, text: "" }));
    try {
      let printed = "";
      const code = await run(["p"], {
        env: {
          [SOCKET_ENV]: served.path,
          [TOKEN_ENV]: "spent",
          [HOST_ENV]: "h",
          [KEY_FILE_ENV]: keyFile(root),
        },
        stdout: (text) => (printed += text),
      });
      expect(code).toBe(1);
      expect(printed).toBe("");
    } finally {
      served.close();
    }
  });

  it("does not hand the token to a server that does not hold the key", async () => {
    const served = await serve(randomBytes(32), () => ({
      status: 200,
      text: "stolen\n",
    }));
    try {
      let printed = "";
      const code = await run(["p"], {
        env: {
          [SOCKET_ENV]: served.path,
          [TOKEN_ENV]: "secret-token",
          [HOST_ENV]: "h",
          [KEY_FILE_ENV]: keyFile(randomBytes(32)),
        },
        stdout: (text) => (printed += text),
      });
      expect(code).toBe(1);
      expect(printed).toBe("");
      expect(served.seen).toEqual([]);
    } finally {
      served.close();
    }
  });

  it("fails without the environment the core sets", async () => {
    expect(await run(["p"], { env: {} })).toBe(1);
    expect(
      await run(["p"], {
        env: {
          [SOCKET_ENV]: "x",
          [TOKEN_ENV]: "t",
          [HOST_ENV]: "h",
          [KEY_FILE_ENV]: "/nonexistent",
        },
      }),
    ).toBe(1);
  });
});

/** Windows runner only: the service on a real pipe, asked by the real client. */
describe.skipIf(process.platform !== "win32")(
  "the askpass service on Windows",
  () => {
    it("answers a prompt over a private pipe and refuses a spent token", async () => {
      const dataDir = tempDir("armadra-askpass-win-");
      const prompts: { promptId: string; hostId: string }[] = [];
      const service = new AskpassService({
        dataDir,
        windowsLauncher: () => join(dataDir, "ssh", "askpass.exe"),
        pipeSecurity: { harden: async () => ({ ok: false, reason: "test" }) },
        onPrompt: (prompt) => prompts.push(prompt),
      });
      try {
        await service.start();
        const env = service.childEnvironment("host-1");
        expect(env).toBeDefined();
        const vars = Object.fromEntries(env ?? []);
        expect(vars.SSH_ASKPASS).toBe(join(dataDir, "ssh", "askpass.exe"));
        expect(vars[MODE_ENV]).toBe("1");
        expect(vars[SOCKET_ENV]).toMatch(
          /^\\\\\.\\pipe\\armadra-askpass-[0-9a-f]{32}$/,
        );
        const answering = (async () => {
          for (let i = 0; i < 100 && prompts.length === 0; i++)
            await new Promise((r) => setTimeout(r, 20));
          const prompt = prompts[0];
          if (prompt)
            service.prompts.answer(prompt.promptId, prompt.hostId, "hunter2");
        })();
        let printed = "";
        const code = await run(["password: "], {
          env: vars,
          stdout: (t) => (printed += t),
        });
        await answering;
        expect(code).toBe(0);
        expect(printed).toBe("hunter2\n");
        // The token was spent by that call.
        expect(
          await run(["again: "], { env: vars, stdout: () => undefined }),
        ).toBe(1);
      } finally {
        await service.stop();
      }
    }, 30_000);

    it("stays off without askpass.exe", async () => {
      const service = new AskpassService({
        dataDir: tempDir("armadra-askpass-win-"),
        windowsLauncher: () => undefined,
        onPrompt: () => undefined,
      });
      await service.start();
      expect(service.childEnvironment("h")).toBeUndefined();
      await service.stop();
    });
  },
);
