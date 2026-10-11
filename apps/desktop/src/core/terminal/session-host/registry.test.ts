import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  REGISTRY_ENV,
  registerHost,
  registeredHosts,
  registryDir,
  unregisterHost,
} from "./registry";

const scrap: string[] = [];
afterEach(() => {
  for (const path of scrap.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "armadra-registry-"));
  scrap.push(path);
  return join(path, "session-hosts");
}

describe("the session host registry", () => {
  it("lives under LOCALAPPDATA, not under any data directory", () => {
    expect(
      registryDir({
        LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
        ARMADRA_DATA_DIR: "D:\\elsewhere",
      }),
    ).toBe("C:\\Users\\a\\AppData\\Local\\Armadra\\session-hosts");
    expect(registryDir({ [REGISTRY_ENV]: "T:\\reg" })).toBe("T:\\reg");
  });

  it("records a host and reads its data directory back", () => {
    const registry = directory();
    expect(registerHost("D:\\work", "\\\\.\\pipe\\a", registry)).toBeNull();
    expect(registeredHosts(registry)).toEqual([
      expect.objectContaining({ dataDir: "D:\\work", pid: process.pid }),
    ]);
  });

  it("keeps one entry per pipe: a restarted host replaces its own", () => {
    const registry = directory();
    registerHost("D:\\work", "\\\\.\\pipe\\a", registry);
    registerHost("D:\\work", "\\\\.\\pipe\\a", registry);
    registerHost("E:\\other", "\\\\.\\pipe\\b", registry);
    expect(
      registeredHosts(registry)
        .map((host) => host.dataDir)
        .sort(),
    ).toEqual(["D:\\work", "E:\\other"]);
    // No temporary file left behind by the rename.
    expect(readdirSync(registry).every((name) => name.endsWith(".json"))).toBe(
      true,
    );
  });

  it("removes only this process' own entry on the way out", () => {
    const registry = directory();
    registerHost("D:\\work", "\\\\.\\pipe\\a", registry);
    const [entry] = registeredHosts(registry);
    // A successor rewrote the entry: it keeps it.
    writeFileSync(
      entry!.file,
      JSON.stringify({ dataDir: "D:\\work", pid: process.pid + 1 }),
    );
    unregisterHost("\\\\.\\pipe\\a", registry);
    expect(existsSync(entry!.file)).toBe(true);
    registerHost("D:\\work", "\\\\.\\pipe\\a", registry);
    unregisterHost("\\\\.\\pipe\\a", registry);
    expect(registeredHosts(registry)).toEqual([]);
  });

  it("drops unreadable entries and ignores other files", () => {
    const registry = directory();
    registerHost("D:\\work", "\\\\.\\pipe\\a", registry);
    writeFileSync(join(registry, "broken.json"), "{");
    writeFileSync(join(registry, "empty.json"), JSON.stringify({ pid: 1 }));
    writeFileSync(join(registry, "notes.txt"), "kept");
    expect(registeredHosts(registry).map((host) => host.dataDir)).toEqual([
      "D:\\work",
    ]);
    expect(existsSync(join(registry, "broken.json"))).toBe(false);
    expect(existsSync(join(registry, "empty.json"))).toBe(false);
    expect(existsSync(join(registry, "notes.txt"))).toBe(true);
  });

  it("answers an empty list when nothing was ever recorded", () => {
    expect(registeredHosts(directory())).toEqual([]);
  });

  it("reports, rather than throws, when the entry cannot be written", () => {
    const registry = directory();
    // A file where the directory should be.
    const blocked = join(registry, "..", "file");
    writeFileSync(blocked, "");
    expect(registerHost("D:\\work", "\\\\.\\pipe\\a", blocked)).not.toBeNull();
  });
});
