import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endpointsSnapshot,
  fallbackEndpoints,
  publishEndpoints,
  readRuntimeBases,
  resetEndpoints,
  resolveEndpoints,
  resolveOwnEndpoints,
} from "./transport";

/**
 * The page's bases. The Runtime's port is kernel-assigned, so `endpoints.json`
 * is the only thing that knows it — and the page reads the answer before its
 * first `await`, which is why a snapshot exists at all.
 */

const EXTERNAL = "http://127.0.0.1:43120";
let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-transport-"));
  resetEndpoints();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  resetEndpoints();
});

function publish(document: unknown): void {
  writeFileSync(join(directory, "endpoints.json"), JSON.stringify(document));
}

describe("resolving the page's bases", () => {
  it("takes the kernel-assigned port out of endpoints.json", async () => {
    publish({
      runtime: {
        http: "http://127.0.0.1:52341",
        websocket: "ws://127.0.0.1:52341",
      },
    });
    expect(await resolveEndpoints(directory, EXTERNAL)).toEqual({
      httpBase: "http://127.0.0.1:52341",
      wsBase: "ws://127.0.0.1:52341",
      dataDir: directory,
    });
  });

  it("falls back to the documented port when nothing is published", async () => {
    expect(await resolveEndpoints(directory, EXTERNAL)).toEqual(
      fallbackEndpoints(EXTERNAL, directory),
    );
    expect(fallbackEndpoints(EXTERNAL, directory).wsBase).toBe(
      "ws://127.0.0.1:43120",
    );
  });

  it("refuses a record that points anywhere but loopback", async () => {
    for (const http of [
      "http://192.168.1.20:43120",
      "https://armadra.example",
      "not a url",
    ]) {
      publish({ runtime: { http } });
      expect(await readRuntimeBases(directory), http).toBeUndefined();
      // The page is given the fallback rather than an address nobody asked
      // for: pointing it at another machine is the one failure that would
      // look like it worked.
      expect((await resolveEndpoints(directory, EXTERNAL)).httpBase).toBe(
        EXTERNAL,
      );
    }
  });

  it("survives a truncated or absent document", async () => {
    expect(await readRuntimeBases(directory)).toBeUndefined();
    writeFileSync(join(directory, "endpoints.json"), '{"runtime":');
    expect(await readRuntimeBases(directory)).toBeUndefined();
  });
});

describe("the record of the Runtime this shell started (#485)", () => {
  const record = (instanceId: string, port: number) => ({
    runtime: {
      instanceId,
      http: `http://127.0.0.1:${port}`,
      websocket: `ws://127.0.0.1:${port}`,
    },
  });

  it("skips a killed Runtime's leftover record until the new one writes its own", async () => {
    // 被杀掉的上一个 core 没有撤回记录；新 core 先在私有地址上应答，稍后才写记录。
    publish(record("previous", 64024));
    let clock = 0;
    let sleeps = 0;
    const answer = await resolveOwnEndpoints(directory, EXTERNAL, "current", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        sleeps += 1;
        if (sleeps === 3) publish(record("current", 61304));
      },
    });
    expect(answer).toEqual({
      httpBase: "http://127.0.0.1:61304",
      wsBase: "ws://127.0.0.1:61304",
      dataDir: directory,
    });
    expect(sleeps).toBe(3);
  });

  it("answers at once when the record already names the instance", async () => {
    publish(record("current", 61304));
    const answer = await resolveOwnEndpoints(directory, EXTERNAL, "current", {
      sleep: async () => {
        throw new Error("should not wait");
      },
    });
    expect(answer.httpBase).toBe("http://127.0.0.1:61304");
  });

  it("gives up after the timeout with what it last read, never hanging", async () => {
    publish(record("previous", 64024));
    let clock = 0;
    const answer = await resolveOwnEndpoints(directory, EXTERNAL, "current", {
      timeoutMs: 200,
      pollMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(answer.httpBase).toBe("http://127.0.0.1:64024");
    expect(clock).toBe(200);
  });

  it("falls back to the documented port when no record ever appears", async () => {
    let clock = 0;
    const answer = await resolveOwnEndpoints(directory, EXTERNAL, "current", {
      timeoutMs: 100,
      pollMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(answer).toEqual(fallbackEndpoints(EXTERNAL, directory));
  });
});

describe("the snapshot the page reads before its first await", () => {
  it("answers the published value, and the fallback until there is one", () => {
    const fallback = fallbackEndpoints(EXTERNAL, directory);
    // Never a hang and never a throw: a pending promise here would look to the
    // front end exactly like a dead Runtime.
    expect(endpointsSnapshot(() => fallback)).toEqual(fallback);

    const resolved = { ...fallback, httpBase: "http://127.0.0.1:52341" };
    publishEndpoints(resolved);
    expect(endpointsSnapshot(() => fallback)).toEqual(resolved);
  });
});
