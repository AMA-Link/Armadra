#!/usr/bin/env node
/**
 * Refuses to compile a `node-pty` whose source is not the patched one.
 *
 * node-pty is the only mature PTY binding for Node, and the TypeScript core's
 * terminal domain has no second option (design `typescript-core.md` §3, PTY
 * row). What it ships with are defects this repository cannot live with, so
 * the source is patched: `patches/node-pty@1.1.0.patch`, which pnpm applies
 * at install time through `patchedDependencies` (`pnpm-workspace.yaml`).
 * Install time is the only point both builds share: `pnpm dev` rebuilds the
 * module with `electron-rebuild`, and `dist` lets electron-builder's own
 * @electron/rebuild compile it — node-pty has no prebuild either of them
 * accepts, so both compile whatever is in `node_modules`. A patch applied by a
 * script on one of those paths only (as this file used to do, before `dev`
 * alone) ships an unpatched `pty.node` from the other (#671).
 *
 * What this file keeps is the check, run before either build compiles:
 *
 *   * **pinned** — it refuses any version but the one whose source was read
 *     line by line;
 *   * **hashed** — the SHA-256 of every patched file must be the one the
 *     reviewed patch produces, because a patch release can change a file
 *     without changing the semver, and pnpm can be told to skip patches;
 *   * **specific** — a missing marker says "the patch is not applied" rather
 *     than only "the hash differs".
 *
 * Moving to another version or editing the patch means re-reading the source,
 * re-generating the patch (`pnpm patch node-pty@<version>`, edit,
 * `pnpm patch-commit`), and moving the pins here — never widening them.
 *
 * ## Defect 1 (macOS): every `PtyFork` leaks ptmx devices
 *
 * `src/unix/pty.cc`, `pty_posix_spawn`, is the whole macOS spawn path. Measured
 * against node-pty 1.1.0's own source:
 *
 * ```c
 *   for (; count < 3; count++) {
 *     low_fds[count] = posix_openpt(O_RDWR);
 *     if (low_fds[count] >= STDERR_FILENO) break;
 *   }
 *   ...
 *   for (; count > 0; count--) close(low_fds[count]);
 * ```
 *
 * The producing loop `break`s *without* incrementing, so the entries it wrote
 * are `low_fds[0] … low_fds[count]` inclusive. The consuming loop runs from
 * `count` down to `1`: it never closes `low_fds[0]`, and when the producing
 * loop ran to completion (`count == 3`) its first iteration reads
 * `low_fds[3]`, one past the end of a three-element array, and closes whatever
 * integer was on the stack there.
 *
 * In any normally-started process fds 0/1/2 are already taken, so the very
 * first `posix_openpt` returns an fd ≥ 3, the loop breaks with `count == 0`,
 * and the close loop's body never executes at all. **One `/dev/ptmx` device
 * per successful spawn, leaked, unconditionally.**
 *
 * The same function also never closes `slave` in the parent. The child gets it
 * through `posix_spawn_file_actions_adddup2`/`addclose`, so the parent's copy
 * has no reader and no writer — it only keeps the pty pair allocated for the
 * lifetime of the process (once the child exits, `lsof` lists it as
 * `(revoked)`). That is the **second** device per spawn.
 *
 * And every early `return` between `*master = posix_openpt(O_RDWR)` and the
 * `posix_spawn` — `grantpt`/`unlockpt`, `TIOCPTYGNAME`, `open(slave)`,
 * `tcsetattr`, `TIOCSWINSZ` — returns with `*master` (and, past the fourth,
 * `slave`) still open and `*err` still at the caller's `-1`. A *failing* spawn
 * therefore leaks a master, sometimes a slave, and all of the low fds, while
 * the JavaScript side sees `posix_spawnp failed.` and retries.
 *
 * macOS caps the number of allocated pty devices at `kern.tty.ptmx_max`
 * (default 511). A leak of two devices per terminal is invisible for an hour
 * and terminal on a machine that opens and closes agent sessions all day:
 * once the cap is hit *every* spawn on the machine fails, including ones that
 * have nothing to do with this application, until the process exits.
 *
 * The patch replaces the whole tail of `pty_posix_spawn` with one `fail:`
 * label that closes `*master` and `slave`, and a cleanup that closes
 * `low_fds[0 … count]` inclusive, guarded against both the `-1` of a failed
 * `posix_openpt` and the out-of-range index. C++ forbids a `goto` over an
 * initialised declaration still in scope at the label, so `slave` and `res`
 * are hoisted to the top of the function.
 *
 * ## Defect 2 (Windows): the ConPTY handle list
 *
 * `src/win/conpty.cc` erases from its global handle list on every exit thread
 * while the JS thread searches or appends to it, and a second kill closes an
 * already freed pseudoconsole — native crashes of the session host that no
 * JavaScript can catch (#659). The same patch backports the upstream mutex and
 * the close-once guard; `pnpm-workspace.yaml` keeps the reason beside the
 * entry.
 *
 * Not patched: the same file frees the baton from the native exit thread
 * before the HPCON is closed, so a process tree killed from outside
 * (`taskkill /T`) can leave a `conhost.exe` alive until the whole daemon
 * exits. TODO(R6): fix it with the Windows session host, on real hardware.
 *
 * ## Linux
 *
 * The Linux path is `forkpty(3)` (`#else` branch of `PtyFork`) and does not go
 * through `pty_posix_spawn` at all, so neither edit applies to it — the macOS
 * hunks live inside `#if defined(__APPLE__)`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");

/** The only version whose source the patch was written against. */
export const PINNED_VERSION = "1.1.0";

/**
 * Per patched file: a line only the patch writes, and the SHA-256 of the file
 * as `patches/node-pty@1.1.0.patch` leaves it.
 */
export const PATCHED_FILES = {
  "src/unix/pty.cc": {
    marker: "/* armadra: pty device leak fix */",
    sha256: "1f806a4a27d8cc7ddaf4a0d1b670bac01d8549067a1a73cf6f87517dc65226d6",
  },
  "src/win/conpty.cc": {
    marker: "static std::mutex g_ptyHandlesMutex;",
    sha256: "27ac472b88765696eaf55597a441697d0c7e28ffb8a4f727058bce6fbd0d0639",
  },
};

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The node-pty this app resolves, as installed. */
export function installedNodePtyDir() {
  const require = createRequire(join(app, "package.json"));
  return dirname(require.resolve("node-pty/package.json"));
}

/**
 * Throws, naming the first thing wrong, unless `root` holds node-pty
 * `PINNED_VERSION` with every file in `files` exactly as the patch leaves it.
 */
export function verifyNodePtySource(
  root = installedNodePtyDir(),
  files = PATCHED_FILES,
) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== PINNED_VERSION) {
    throw new Error(
      `node-pty ${manifest.version} is installed, but its patch was written against ${PINNED_VERSION}. ` +
        `Read the new source, re-derive the patch, and move the pin — do not widen it.`,
    );
  }
  for (const [file, { marker, sha256: expected }] of Object.entries(files)) {
    const source = readFileSync(join(root, file), "utf8");
    if (!source.includes(marker)) {
      throw new Error(
        `${file} is not patched: patches/node-pty@${PINNED_VERSION}.patch was not applied. ` +
          `Reinstall with pnpm (patchedDependencies) before building.`,
      );
    }
    const digest = sha256(source);
    if (digest !== expected) {
      throw new Error(
        `${file} hashes ${digest}, expected ${expected}. ` +
          `The source or the patch changed; re-read it and move the pin.`,
      );
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    verifyNodePtySource();
    process.stdout.write(
      `node-pty ${PINNED_VERSION}: patched source verified\n`,
    );
  } catch (error) {
    process.stderr.write(`verify-node-pty: ${error.message}\n`);
    process.exit(1);
  }
}
