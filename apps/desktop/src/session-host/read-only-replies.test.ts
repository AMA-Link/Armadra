import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKey } from "../core/terminal/session-host/auth";
import {
  SessionHostBackend,
  sessionHostEnvironment,
} from "../core/terminal/session-host/backend";
import { PIPE_PREFIX } from "../core/terminal/session-host/protocol";
import { sessionKey } from "../core/terminal/backend";
import { type FakePty, fakeSpawner } from "./fake-pty";
import { SessionHost } from "./server";

/**
 * The core tells the session host whether an attachment is read-only (#565),
 * and the host answers the console's queries itself while no writable view is
 * attached. The real backend against the real host over a fake console, as
 * `capture.test.ts` does.
 */

const scrap: (() => void)[] = [];

afterEach(async () => {
  for (const undo of scrap.splice(0).reverse()) await undo();
});

interface Harness {
  readonly backend: SessionHostBackend;
  last(): FakePty;
}

async function serve(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-readonly-"));
  const endpoint =
    process.platform === "win32"
      ? `${PIPE_PREFIX}capture-${randomBytes(8).toString("hex")}`
      : join(dataDir, "s");
  const spawner = fakeSpawner();
  const host = new SessionHost({
    dataDir,
    endpoint,
    key: ensureKey(dataDir),
    version: "armadra-session-host/test",
    spawn: spawner.spawn,
    tickMs: 60_000,
  });
  await host.listen();
  scrap.push(async () => {
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const backend = new SessionHostBackend({
    dataDir,
    endpoint,
    version: "test",
  });
  return { backend, last: spawner.last };
}

const KEY = sessionKey("node-readonly");
const SIZE = { cols: 40, rows: 6 };

async function started(harness: Harness): Promise<void> {
  await harness.backend.create({
    sessionKey: KEY,
    generation: 1,
    workspaceId: "ws",
    cwd: tmpdir(),
    shell: "powershell.exe",
    args: [],
    env: [],
    size: SIZE,
  } as unknown as Parameters<SessionHostBackend["create"]>[0]);
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("read-only attachments and the host's own answers", () => {
  it("keeps answering for a read-only view and stops for a writable one", async () => {
    const harness = await serve();
    await started(harness);
    const seen: string[] = [];
    const watcher = await harness.backend.attach(KEY, 1, SIZE, {
      readOnly: true,
    });
    watcher.onData((chunk) => seen.push(chunk.toString()));

    harness.last().emit("\u001b[c");
    await until(() => harness.last().writes.length === 1, "the host's answer");
    expect(harness.last().writes).toEqual(["\u001b[?1;0c"]);

    const driver = await harness.backend.attach(KEY, 1, SIZE);
    const driven: string[] = [];
    driver.onData((chunk) => driven.push(chunk.toString()));
    harness.last().emit("\u001b[c");
    await until(() => driven.length > 0, "live output");
    expect(harness.last().writes).toHaveLength(1);

    await harness.backend.detach(KEY, driver.attachmentId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.last().emit("\u001b[c");
    await until(() => harness.last().writes.length === 2, "the host's answer");
  });
});
