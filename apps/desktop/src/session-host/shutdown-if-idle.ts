import { resolve } from "node:path";

import {
  type RegisteredHost,
  registeredHosts,
  removeEntry,
} from "../core/terminal/session-host/registry";
import {
  type ShutdownOutcome,
  requestShutdownIfIdle,
} from "../core/terminal/session-host/shutdown";

/**
 * `shutdown-if-idle.cjs` — what the NSIS installer and uninstaller run before
 * they replace or remove `Armadra.exe` (`build/installer.nsh`).
 *
 * The session host runs on `Armadra.exe` itself (`ELECTRON_RUN_AS_NODE=1`),
 * so a host left over from the last run is exactly the process the
 * installer's "is the app running?" step would otherwise kill by name. This
 * asks it to leave first, the same `shutdownIfIdle` the shell sends on quit,
 * and waits up to {@link WAIT_MS} for its process to end. A host that still
 * owns a session stays, and the installer's own handling takes it from there.
 *
 * A separate file rather than a mode of `host.cjs`: the installer only runs
 * it when it exists, and an older install's `host.cjs` given a data directory
 * would *start* a host rather than stop one.
 *
 * Like the host, it takes exactly one argument — the data directory — and
 * always exits 0 once that is valid: nothing it can find out should stop an
 * uninstall.
 *
 * The installer only knows the default data directory (or an
 * `ARMADRA_DATA_DIR` set in its own environment), and a host serving another
 * one derives another pipe and key. So the directories every running host
 * recorded (`core/terminal/session-host/registry.ts`) are asked too, each the
 * ordinary way; an entry whose host is not there any more is removed.
 */

export const WAIT_MS = 5_000;

export interface ShutdownRunOptions {
  readonly argv?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly log?: (line: string) => void;
  readonly request?: typeof requestShutdownIfIdle;
  /** The recorded hosts; the per-user registry when absent. */
  readonly registered?: () => readonly RegisteredHost[];
  readonly forget?: (file: string) => void;
}

/** One spelling per directory: Windows paths compare without case. */
function sameDirectory(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

export async function runShutdownIfIdle(
  options: ShutdownRunOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const platform = options.platform ?? process.platform;
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (platform !== "win32") {
    log("shutdown-if-idle: the session host only exists on Windows");
    return 0;
  }
  const dataDir = argv[0];
  if (argv.length !== 1 || dataDir === undefined || dataDir.trim() === "") {
    log("usage: shutdown-if-idle <user-data-dir>");
    return 2;
  }
  const request = options.request ?? requestShutdownIfIdle;
  const forget = options.forget ?? removeEntry;
  let registered: readonly RegisteredHost[] = [];
  try {
    registered = (options.registered ?? registeredHosts)();
  } catch (error) {
    log(
      `shutdown-if-idle: could not read the registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const directories: { dataDir: string; entries: RegisteredHost[] }[] = [
    { dataDir, entries: [] },
  ];
  for (const entry of registered) {
    const known = directories.find((item) =>
      sameDirectory(item.dataDir, entry.dataDir),
    );
    if (known === undefined) {
      directories.push({ dataDir: entry.dataDir, entries: [entry] });
    } else {
      known.entries.push(entry);
    }
  }
  // Together, not one after another: each may wait out its own host.
  await Promise.all(
    directories.map(async ({ dataDir: directory, entries }) => {
      const outcome: ShutdownOutcome = await request({
        dataDir: directory,
        client: "armadra-installer",
        waitMs: WAIT_MS,
      });
      log(
        `shutdown-if-idle: ${JSON.stringify({ dataDir: directory, ...outcome })}`,
      );
      // Nothing listens there: the entry outlived a host that was killed.
      if (outcome.kind === "absent") {
        for (const entry of entries) forget(entry.file);
      }
    }),
  );
  return 0;
}

if (require.main === module) {
  void runShutdownIfIdle().then((code) => {
    process.exitCode = code;
  });
}
