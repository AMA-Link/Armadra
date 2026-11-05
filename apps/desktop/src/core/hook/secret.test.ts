import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ResolvedSecrets,
  type SecretBackend,
  type SecurityTool,
  SecretUnavailable,
  keychainBackend,
  migrationRecordFile,
  unavailableBackend,
} from "../secrets";
import { tempDir } from "../testing/temp-dir";
import { HookAuth } from "./auth";
import {
  HOOK_SECRET_NAME,
  hookSecretStore,
  legacyHookSecretFile,
} from "./secret";
import { HookService } from "./service";

/** A backend that is a Map; `failSets` makes the first writes throw. */
function memoryBackend(failSets = 0): SecretBackend & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  let failures = failSets;
  return {
    kind: "keychain",
    values,
    async get(name) {
      return values.get(name);
    },
    async set(name, value) {
      if (failures > 0) {
        failures -= 1;
        throw new SecretUnavailable("locked");
      }
      values.set(name, value);
    },
    async delete(name) {
      values.delete(name);
    },
  };
}

function resolved(dataDir: string, backend: SecretBackend): ResolvedSecrets {
  return { backend, dataDir, security: {} as SecurityTool };
}

async function open(dataDir: string, backend: SecretBackend) {
  return HookAuth.open(dataDir, hookSecretStore(resolved(dataDir, backend)));
}

describe("the hook secret in the secret store", () => {
  it("mints once into the store and writes no hook-secret file", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const backend = memoryBackend();
    const first = await open(dir, backend);
    expect(first.state).toBe("keychain");
    expect(existsSync(legacyHookSecretFile(dir))).toBe(false);
    const stored = backend.values.get(HOOK_SECRET_NAME);
    expect(Buffer.from(stored ?? "", "base64url")).toHaveLength(32);
    const second = await open(dir, backend);
    expect(second.kid).toBe(first.kid);
  });

  it("moves an old hook-secret file over without changing the kid", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const old = randomBytes(32);
    writeFileSync(legacyHookSecretFile(dir), old);
    const backend = memoryBackend();
    const auth = await open(dir, backend);
    expect(auth.state).toBe("keychain");
    expect(backend.values.get(HOOK_SECRET_NAME)).toBe(
      old.toString("base64url"),
    );
    expect(existsSync(legacyHookSecretFile(dir))).toBe(false);
    expect(readFileSync(migrationRecordFile(dir), "utf8")).toContain(
      "hook.file",
    );
    // The same bytes as before, so a token minted back then is still verified.
    const before = HookAuth.ephemeral();
    expect(before.kid).not.toBe(auth.kid);
    const again = await open(dir, backend);
    expect(again.nodeToken("n")).toBe(auth.nodeToken("n"));
    expect(auth.verdict("n", again.nodeToken("n"))).toBe("verified");
  });

  it("the old file wins over a value already under the new name", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const old = randomBytes(32);
    writeFileSync(legacyHookSecretFile(dir), old);
    // Someone else (an isolated run on a shared keychain) wrote here first.
    const backend = memoryBackend();
    backend.values.set(HOOK_SECRET_NAME, randomBytes(32).toString("base64url"));
    const auth = await open(dir, backend);
    expect(auth.state).toBe("keychain");
    expect(backend.values.get(HOOK_SECRET_NAME)).toBe(
      old.toString("base64url"),
    );
    expect(existsSync(legacyHookSecretFile(dir))).toBe(false);
  });

  it("never reads the name unreleased builds used", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const stale = randomBytes(32).toString("base64url");
    const backend = memoryBackend();
    backend.values.set("armadra-hook-secret", stale);
    expect(HOOK_SECRET_NAME).not.toBe("armadra-hook-secret");
    await open(dir, backend);
    expect(backend.values.get(HOOK_SECRET_NAME)).not.toBe(stale);
    expect(backend.values.get("armadra-hook-secret")).toBe(stale);
  });

  it("does not migrate twice and ignores an old file of the wrong length", async () => {
    const dir = tempDir("armadra-hook-secret-");
    writeFileSync(legacyHookSecretFile(dir), randomBytes(31));
    const backend = memoryBackend();
    const auth = await open(dir, backend);
    expect(auth.state).toBe("keychain");
    expect(backend.values.has(HOOK_SECRET_NAME)).toBe(true);
    // A truncated file is no secret: a fresh one was minted, not 31 bytes padded.
    expect(
      Buffer.from(backend.values.get(HOOK_SECRET_NAME) ?? "", "base64url"),
    ).toHaveLength(32);
  });

  it("an interrupted migration keeps the old file and finishes next start", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const old = randomBytes(32);
    writeFileSync(legacyHookSecretFile(dir), old);
    const backend = memoryBackend(1);
    const first = await open(dir, backend);
    // The store refused the write: this run reads the old file, nothing minted.
    expect(first.state).toBe("legacy-file");
    expect(existsSync(legacyHookSecretFile(dir))).toBe(true);
    expect(backend.values.size).toBe(0);
    const second = await open(dir, backend);
    expect(second.state).toBe("keychain");
    expect(second.kid).toBe(first.kid);
    expect(existsSync(legacyHookSecretFile(dir))).toBe(false);
  });

  it("an unreachable store mints nothing and runs ephemeral", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const backend = unavailableBackend("keychain", "locked");
    const one = await open(dir, backend);
    const two = await open(dir, backend);
    expect(one.state).toBe("ephemeral");
    // Two runs, two secrets: nothing was persisted behind the user's back.
    expect(two.kid).not.toBe(one.kid);
    expect(existsSync(legacyHookSecretFile(dir))).toBe(false);
  });

  it("no default keychain: ephemeral, the old file stays, no item command runs", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const old = randomBytes(32);
    writeFileSync(legacyHookSecretFile(dir), old, { mode: 0o600 });
    const calls: string[] = [];
    const tool: SecurityTool = async (args) => {
      calls.push(args[0] ?? "");
      return { code: 1, stdout: "" };
    };
    const auth = await open(dir, keychainBackend(tool));
    // The old file still answers this run; nothing was written anywhere.
    expect(auth.state).toBe("legacy-file");
    expect(readFileSync(legacyHookSecretFile(dir))).toEqual(old);
    expect(calls.every((verb) => verb === "default-keychain")).toBe(true);

    const fresh = tempDir("armadra-hook-secret-");
    const none = await open(fresh, keychainBackend(tool));
    expect(none.state).toBe("ephemeral");
    expect(calls.every((verb) => verb === "default-keychain")).toBe(true);
  });

  it("an unreachable store never overwrites a value it only cannot read", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const backend = memoryBackend();
    const original = await open(dir, backend);
    const locked: SecretBackend = {
      kind: "keychain",
      get: () => Promise.reject(new SecretUnavailable("locked")),
      set: () => {
        throw new Error("must not write");
      },
      delete: () => Promise.resolve(),
    };
    const during = await open(dir, locked);
    expect(during.state).toBe("ephemeral");
    expect(during.kid).not.toBe(original.kid);
    const after = await open(dir, backend);
    expect(after.kid).toBe(original.kid);
  });

  it("reports the state in /health and keeps the bearer", async () => {
    const dir = tempDir("armadra-hook-secret-");
    const service = await HookService.open(
      dir,
      43119,
      () => {},
      resolved(dir, unavailableBackend("keychain", "locked")),
    );
    service.publishEndpoint(43119);
    expect(service.health().secret).toBe("ephemeral");
    const healthy = await HookService.open(
      dir,
      43119,
      () => {},
      resolved(dir, memoryBackend()),
    );
    expect(healthy.health().secret).toBe("keychain");
    expect(healthy.bearer()).toBe(service.bearer());
  });
});
