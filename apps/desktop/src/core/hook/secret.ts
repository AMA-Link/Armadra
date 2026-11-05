import { join } from "node:path";
import {
  type ResolvedSecrets,
  type SecretBackendKind,
  SecretStore,
  legacyBinaryFile,
  migrateLegacySecrets,
  migrationRecordFile,
  resolveSecretBackend,
} from "../secrets";

/**
 * Where the hook instance secret lives — contract §102.
 *
 * It used to be `<data>/hook-secret`, a plaintext 32-byte file. It is now one
 * entry in the core's secret backend (Keychain, safeStorage, the encrypted
 * file of the server shell), so a copy of the data directory — a backup, a
 * sync folder, a diagnostic bundle — no longer carries the key that mints
 * every node token.
 */
export const HOOK_SECRET_NAME = "armadra-hook-secret";
export const HOOK_SECRET_BYTES = 32;

/** The legacy plaintext file. Only the one-time migration reads it. */
export function legacyHookSecretFile(dataDir: string): string {
  return join(dataDir, "hook-secret");
}

/** Where the secret of this run came from; `/health` reports it. */
export type HookSecretState =
  | SecretBackendKind
  /** The store was unreachable and the old file is still the source: retried next start. */
  | "legacy-file"
  /** The store was unreachable and nothing was minted: this run only. */
  | "ephemeral";

/**
 * The hook secret as a {@link SecretStore}. The first read or write moves the
 * old file over (write, read back, delete, record) and waits for it, so a read
 * never sees an empty slot that is about to be filled.
 */
export function hookSecretStore(secrets: ResolvedSecrets): SecretStore {
  let migrated: Promise<unknown> | undefined;
  const migrate = () =>
    (migrated ??= migrateLegacySecrets(
      secrets.backend,
      [
        legacyBinaryFile(
          "hook.file",
          HOOK_SECRET_NAME,
          legacyHookSecretFile(secrets.dataDir),
          HOOK_SECRET_BYTES,
        ),
      ],
      migrationRecordFile(secrets.dataDir),
    ));
  return new SecretStore(secrets.backend, HOOK_SECRET_NAME, migrate);
}

/**
 * The store for callers that were not handed the core's backend (tests, the
 * standalone fixtures): the 0600 file backend, never the developer's keychain.
 */
export function fileHookSecretStore(dataDir: string): SecretStore {
  return hookSecretStore(
    resolveSecretBackend({
      dataDir,
      env: { ARMADRA_SECRET_BACKEND: "file" },
    }),
  );
}
