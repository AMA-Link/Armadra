import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_SERVICE, publish, serviceEndpointNow } from "../endpoints";
import { endpointsFile } from "../paths";
import { channelKey, ensurePipeKey, guardServer } from "../private-pipe";
import { CONTROL_LABEL } from "../private-pipe/labels";
import { tempDir } from "../testing/temp-dir";
import { CONTROL_SOCKET } from "./control";
import { requestControl, resolveControlTarget } from "./control-client";

describe("finding the identity channel", () => {
  it("is the socket in the data directory off Windows", () => {
    const dir = tempDir("armadra-cc-");
    expect(resolveControlTarget(dir, "linux")).toEqual({
      path: join(dir, CONTROL_SOCKET),
    });
  });

  it("is the published pipe with a handshake keyed from pipe.key on Windows", () => {
    const dir = tempDir("armadra-cc-");
    const key = ensurePipeKey(dir);
    publish(endpointsFile(dir), CONTROL_SERVICE, {
      ...serviceEndpointNow("abc"),
      pipe: "\\\\.\\pipe\\armadra-control-0011",
    });
    const target = resolveControlTarget(dir, "win32");
    expect(target?.path).toBe("\\\\.\\pipe\\armadra-control-0011");
    expect(target?.channel?.label).toBe(CONTROL_LABEL);
    expect(target?.channel?.key.equals(channelKey(key, CONTROL_LABEL))).toBe(
      true,
    );
  });

  it("is nothing when no pipe is published, the name is odd or the key is missing", () => {
    const dir = tempDir("armadra-cc-");
    expect(resolveControlTarget(dir, "win32")).toBeUndefined();
    ensurePipeKey(dir);
    expect(resolveControlTarget(dir, "win32")).toBeUndefined();
    publish(endpointsFile(dir), CONTROL_SERVICE, {
      ...serviceEndpointNow("abc"),
      pipe: "C:\\evil\\not-a-pipe",
    });
    expect(resolveControlTarget(dir, "win32")).toBeUndefined();
    const bare = tempDir("armadra-cc-");
    mkdirSync(bare, { recursive: true });
    publish(endpointsFile(bare), CONTROL_SERVICE, {
      ...serviceEndpointNow("abc"),
      pipe: "\\\\.\\pipe\\armadra-control-0011",
    });
    expect(resolveControlTarget(bare, "win32")).toBeUndefined();
    writeFileSync(join(bare, "pipe.key"), "not hex\n");
    expect(resolveControlTarget(bare, "win32")).toBeUndefined();
  });
});

/** Runs on every platform: the handshake sits in front of a Unix socket here. */
describe.skipIf(process.platform === "win32")(
  "requesting through the handshake",
  () => {
    async function guarded(root: Buffer) {
      const path = join(tempDir("armadra-cc-"), "c.sock");
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ path: request.url }));
      });
      const channel = {
        label: CONTROL_LABEL,
        pipe: "armadra-control-test",
        key: channelKey(root, CONTROL_LABEL),
      };
      guardServer(server, { channel });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      return { path, channel, close: () => server.close() };
    }

    it("completes the handshake and then gets the answer", async () => {
      const root = randomBytes(32);
      const served = await guarded(root);
      try {
        const answer = await requestControl(
          { path: served.path, channel: served.channel },
          {
            method: "POST",
            path: "/control/identity/ticket",
            body: Buffer.from("{}"),
          },
        );
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body.toString("utf8"))).toEqual({
          path: "/control/identity/ticket",
        });
      } finally {
        served.close();
      }
    });

    it("fails against a server that holds another key", async () => {
      const served = await guarded(randomBytes(32));
      try {
        await expect(
          requestControl(
            {
              path: served.path,
              channel: {
                ...served.channel,
                key: channelKey(randomBytes(32), CONTROL_LABEL),
              },
            },
            { method: "GET", path: "/x", timeoutMs: 1000 },
          ),
        ).rejects.toThrow();
      } finally {
        served.close();
      }
    });
  },
);
