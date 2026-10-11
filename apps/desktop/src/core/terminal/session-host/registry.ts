import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

/**
 * Where this user's session hosts say which data directory they serve.
 *
 * The pipe name and the key both derive from the data directory, so a caller
 * that does not know the directory cannot reach the host. The installer is
 * such a caller: it runs without the user's `ARMADRA_DATA_DIR`, guesses
 * `%LOCALAPPDATA%\Armadra`, and a host serving any other directory was then
 * left for the stock "the app is running" step to kill (G5-21).
 *
 * So a host that is listening drops one small file here — the data directory
 * and its pid — in a place that does **not** depend on the data directory:
 * `%LOCALAPPDATA%\Armadra\session-hosts\`. The installer's helper reads every
 * entry and asks each directory's host the ordinary way.
 *
 * Only the data directory is read back. The pipe name and the key are still
 * derived from it and the handshake still proves the key, so an entry someone
 * else wrote can at most make the helper ask a directory it could have been
 * told on its command line anyway.
 */

/** Overrides the directory, for tests that start real hosts. */
export const REGISTRY_ENV = "ARMADRA_SESSION_HOST_REGISTRY";

export interface RegisteredHost {
  /** The entry's file, to remove it once its host is known to be gone. */
  readonly file: string;
  readonly dataDir: string;
  readonly pid: number;
}

/** The per-user registry directory; fixed, never under a data directory. */
export function registryDir(ambient: NodeJS.ProcessEnv = process.env): string {
  const named = ambient[REGISTRY_ENV];
  if (named !== undefined && named.trim() !== "") return named;
  const local =
    ambient.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local");
  return win32.join(local, "Armadra", "session-hosts");
}

/** One file per endpoint, so a host that restarts replaces its own entry. */
function entryName(endpoint: string): string {
  return `${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}.json`;
}

/**
 * Records that this process serves `dataDir` on `endpoint`. Best effort: a
 * host that cannot write here still serves, it is only harder to uninstall
 * around, so the failure is returned for the log rather than thrown.
 */
export function registerHost(
  dataDir: string,
  endpoint: string,
  directory: string = registryDir(),
): string | null {
  try {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, entryName(endpoint));
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ dataDir, pid: process.pid, startedAt: Date.now() }),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Removes this process' entry for `endpoint` on the way out — only if it is
 * still this process': a successor that already rewrote it keeps its entry.
 */
export function unregisterHost(
  endpoint: string,
  directory: string = registryDir(),
): void {
  const path = join(directory, entryName(endpoint));
  if (readEntry(path)?.pid !== process.pid) return;
  removeEntry(path);
}

function readEntry(path: string): RegisteredHost | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      dataDir?: unknown;
      pid?: unknown;
    };
    if (
      typeof parsed.dataDir !== "string" ||
      parsed.dataDir.trim() === "" ||
      parsed.dataDir.length > 4096 ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid)
    ) {
      return undefined;
    }
    return { file: path, dataDir: parsed.dataDir, pid: parsed.pid };
  } catch {
    return undefined;
  }
}

/**
 * Every readable entry. An unreadable one is debris (a host killed while
 * writing) and is removed, so the directory does not grow without bound.
 */
export function registeredHosts(
  directory: string = registryDir(),
): RegisteredHost[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const hosts: RegisteredHost[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const entry = readEntry(path);
    if (entry === undefined) removeEntry(path);
    else hosts.push(entry);
  }
  return hosts;
}

export function removeEntry(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Someone else removed it first; nothing to repair.
  }
}
