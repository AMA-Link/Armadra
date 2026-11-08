import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodePluginSource } from "./extension-template";
import { tempDir } from "../../testing/temp-dir";

/**
 * The injected opencode plugin, run for real against a stub runtime and a
 * stub opencode client: a canvas answer file turns into one permission reply
 * (contract §109), and nothing else ever does.
 */

type Hooks = {
  event: (input: { event: Record<string, unknown> }) => Promise<void>;
};

const saved = { ...process.env };
let server: Server;
let directory: string;
let replies: Array<Record<string, unknown>>;

beforeEach(async () => {
  directory = tempDir("armadra-opencode-answers-");
  replies = [];
  server = createServer((request, response) => {
    request.resume();
    response.statusCode = 204;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(
    join(directory, "endpoint.env"),
    `ARMADRA_HOOK_PORT=${port}\nARMADRA_HOOK_TOKEN=t\n`,
  );
  process.env.ARMADRA_NODE_ID = "node-1";
  process.env.ARMADRA_ENDPOINT_FILE = join(directory, "endpoint.env");
  process.env.ARMADRA_PERM_WAIT_SECS = "5";
});

afterEach(async () => {
  process.env = { ...saved };
  await new Promise((resolve) => server.close(resolve));
});

async function load(): Promise<Hooks> {
  const file = join(directory, "plugin.mjs");
  writeFileSync(file, opencodePluginSource("opencode", "/bin/true"));
  const module = (await import(/* @vite-ignore */ file)) as {
    ArmadraStatus: (input: unknown) => Promise<Hooks>;
  };
  const client = {
    permission: {
      reply: async (input: Record<string, unknown>) => {
        replies.push(input);
      },
    },
  };
  return module.ArmadraStatus({ client });
}

const asked = {
  type: "permission.asked",
  properties: { id: "per_abc", sessionID: "ses_1", permission: "bash" },
};

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the opencode plugin answers", () => {
  it("replies once to an allow answer and cleans up", async () => {
    const hooks = await load();
    await hooks.event({ event: asked });
    const pending = join(directory, "pending");
    expect(existsSync(join(pending, "per_abc.json"))).toBe(true);
    writeFileSync(join(pending, "per_abc.answer"), "allow");
    await until(() => replies.length > 0);
    expect(replies).toEqual([{ requestID: "per_abc", reply: "once" }]);
    await until(() => !existsSync(join(pending, "per_abc.json")));
    expect(existsSync(join(pending, "per_abc.json"))).toBe(false);
    expect(existsSync(join(pending, "per_abc.answer"))).toBe(false);
  });

  it("rejects on a deny answer", async () => {
    const hooks = await load();
    await hooks.event({ event: asked });
    writeFileSync(join(directory, "pending", "per_abc.answer"), "deny");
    await until(() => replies.length > 0);
    expect(replies).toEqual([{ requestID: "per_abc", reply: "reject" }]);
  });

  it("never replies to an answer it does not understand", async () => {
    const hooks = await load();
    await hooks.event({ event: asked });
    writeFileSync(join(directory, "pending", "per_abc.answer"), "maybe");
    await until(
      () => !existsSync(join(directory, "pending", "per_abc.answer")),
    );
    expect(replies).toEqual([]);
  });

  it("stops waiting once the human answered in the terminal", async () => {
    const hooks = await load();
    await hooks.event({ event: asked });
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_1", requestID: "per_abc", reply: "once" },
      },
    });
    await until(() => !existsSync(join(directory, "pending", "per_abc.json")));
    expect(existsSync(join(directory, "pending", "per_abc.json"))).toBe(false);
    expect(replies).toEqual([]);
  });

  it("leaves the prompt alone when canvas answers are off", async () => {
    delete process.env.ARMADRA_PERM_WAIT_SECS;
    const hooks = await load();
    await hooks.event({ event: asked });
    mkdirSync(join(directory, "pending"), { recursive: true });
    expect(existsSync(join(directory, "pending", "per_abc.json"))).toBe(false);
    expect(replies).toEqual([]);
  });

  it("refuses an id that could name another file", async () => {
    const hooks = await load();
    await hooks.event({
      event: { type: "permission.asked", properties: { id: "../escape" } },
    });
    expect(existsSync(join(directory, "escape.json"))).toBe(false);
    expect(existsSync(join(directory, "pending"))).toBe(false);
  });
});
