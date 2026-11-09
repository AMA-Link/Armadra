import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";

/**
 * Windows access control for the core's private channels — contract §102.2.
 *
 * Three pieces, none of which needs a native module:
 *
 *   * {@link hardenPipe} replaces a named pipe's DACL after the core bound it.
 *     `node:net` makes the pipe with a default descriptor that Everyone and
 *     Anonymous can read, and Node has no API to change one. The change is made
 *     by `armadra-winsec.exe` (a C# program compiled by the `csc.exe` every
 *     Windows ships, like `armadra-hook.exe`), or, in a development tree that
 *     has no `.exe`, by Windows PowerShell 5.1 calling the same .NET classes.
 *   * {@link verifyPipeSddl} is the pure check of what was read back. The core
 *     serves nothing on a pipe until it passes.
 *   * {@link protectKeyFile} and {@link hardenDataRoot} tighten files and the
 *     data directory with `icacls`.
 *
 * The descriptor is `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;<user SID>)`: protected
 * (inherits nothing), network logons denied first, then SYSTEM and this user.
 * It stops other accounts and remote SMB clients. It does not stop this user's
 * own processes or an administrator, and says so.
 */

/* ----------------------------- who is running ----------------------------- */

/**
 * This user's SID.
 *
 * `whoami /user` is the only way to it without a native module, and its output
 * is stable across every supported Windows version. A failure here is fatal
 * rather than defaulted: the SID is half the pipe name, and guessing it would
 * aim this core at somebody else's host.
 */
export function currentSid(): string {
  const output = execFileSync(systemWhoami(), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  // `"DOMAIN\user","S-1-5-21-…"`
  const sid = /"(S-1-[0-9-]+)"/.exec(output)?.[1];
  if (sid === undefined) {
    throw new Error(`could not read this user's SID from: ${output.trim()}`);
  }
  return sid;
}

/**
 * Windows' own `whoami.exe`, by absolute path. A bare `whoami` resolves on
 * `PATH`, and Git for Windows' `usr\bin` (on `PATH` for anyone who chose "Git
 * and optional Unix tools", and for every GitHub Actions bash step) ships the
 * GNU one, which answers `/user` with "extra operand" — and the core then
 * cannot reach any session host at all.
 */
export function systemWhoami(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), "System32", "whoami.exe");
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
}

/** `DOMAIN\user`, or the bare user name when there is no domain. */
export function windowsAccount(environment: NodeJS.ProcessEnv): string {
  const user = environment.USERNAME ?? "";
  if (user === "") {
    throw new Error("USERNAME is not set; cannot name the account to grant");
  }
  const domain = environment.USERDOMAIN ?? "";
  return domain === "" ? user : `${domain}\\${user}`;
}

/* ------------------------------ files and dirs ----------------------------- */

/**
 * Narrows a key file to this user, and throws if it cannot.
 *
 * POSIX needs only the `chmod` the write already applied; it is repeated
 * because a file inherited from an earlier build may be wider. Windows needs
 * `icacls`: `/inheritance:r` drops the ACEs the parent directory contributed
 * — which on a default profile include Administrators and SYSTEM — and
 * `/grant:r <user>:F` puts exactly one back.
 */
export function protectKeyFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  const account = windowsAccount(environment);
  try {
    execFileSync(
      "icacls",
      [path, "/inheritance:r", "/grant:r", `${account}:F`],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
  } catch (error) {
    throw new Error(
      `无法收紧密钥文件的权限（icacls ${path}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Marker saying the data directory root was already narrowed for a SID. */
const ROOT_MARKER = ".acl-owner-only";

export interface HardenRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly sid?: () => string;
  readonly icacls?: (args: readonly string[]) => void;
  readonly warn?: (message: string, detail: unknown) => void;
}

/**
 * Narrows the data directory root to this user and SYSTEM (no inheritance), once.
 *
 * Everything in the data directory is a grant of the core's API, and a default
 * user profile lets Administrators and, depending on where the directory is,
 * other accounts read it. Failing is not fatal — a redirected or network
 * directory may have no ACLs at all — but it is said: the private pipes then
 * rely on their handshake alone.
 *
 * `true` when the root is narrowed (now or before).
 */
export function hardenDataRoot(
  dataDir: string,
  options: HardenRootOptions = {},
): boolean {
  if ((options.platform ?? process.platform) !== "win32") return true;
  const warn = options.warn ?? (() => {});
  try {
    mkdirSync(dataDir, { recursive: true });
    const sid = (options.sid ?? currentSid)();
    const marker = join(dataDir, ROOT_MARKER);
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === sid) {
      return true;
    }
    const icacls =
      options.icacls ??
      ((args: readonly string[]) => {
        execFileSync("icacls", [...args], {
          windowsHide: true,
          stdio: "ignore",
        });
      });
    icacls([
      dataDir,
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
    ]);
    writeFileSync(marker, `${sid}\n`);
    return true;
  } catch (error) {
    warn("could not restrict the data directory to this user", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/* ------------------------------- pipe DACLs ------------------------------- */

/** The descriptor a private pipe is given. */
export function pipeSddl(sid: string): string {
  return `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;${sid})`;
}

export type SddlVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const FULL_CONTROL_RIGHTS = new Set([
  "ga",
  "fa",
  "0x10000000",
  "0x1f01ff",
  "0x1fffff",
]);

/**
 * Whether `sddl` — as read back from the pipe — is exactly the descriptor we
 * set: a protected DACL, a deny for NETWORK first, then SYSTEM and `sid`, and
 * nothing else. Pure, so the vectors run on every platform.
 *
 * Tolerated spellings: the SID of SYSTEM / NETWORK instead of `SY` / `NU`, the
 * full-control right as `FA` or its mask, the auto-inherited flag `AI`.
 */
export function verifyPipeSddl(sddl: string, sid: string): SddlVerdict {
  const text = sddl.trim();
  const match = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(text);
  if (match === null) return { ok: false, reason: "not a DACL-only SDDL" };
  const flags = match[1] ?? "";
  if (!flags.includes("P"))
    return { ok: false, reason: "DACL is not protected" };
  if (flags.replace(/P|AI/g, "") !== "") {
    return { ok: false, reason: `unexpected DACL flags ${flags}` };
  }
  const aces = [...(match[2] ?? "").matchAll(/\(([^()]*)\)/g)].map(
    (entry) => entry[1] ?? "",
  );
  if (aces.length !== 3) {
    return { ok: false, reason: `expected 3 ACEs, found ${aces.length}` };
  }
  const parsed = aces.map((ace) => ace.split(";"));
  for (const parts of parsed) {
    if (parts.length !== 6) return { ok: false, reason: "malformed ACE" };
    const [, aceFlags, , objectGuid, inheritGuid] = parts;
    if (aceFlags !== "" || objectGuid !== "" || inheritGuid !== "") {
      return { ok: false, reason: "ACE carries flags or object GUIDs" };
    }
  }
  const rights = (parts: readonly string[]): boolean =>
    FULL_CONTROL_RIGHTS.has((parts[2] ?? "").toLowerCase());
  const trustee = (parts: readonly string[]): string =>
    (parts[5] ?? "").toUpperCase();
  const [first, second, third] = parsed as [string[], string[], string[]];
  if (first[0] !== "D" || !rights(first) || !isNetwork(trustee(first))) {
    return { ok: false, reason: "the NETWORK deny is missing or not first" };
  }
  const allowed = [second, third];
  for (const parts of allowed) {
    if (parts[0] !== "A" || !rights(parts)) {
      return { ok: false, reason: "an allow ACE is not full control" };
    }
  }
  const trustees = allowed.map(trustee);
  const hasSystem = trustees.some(isSystem);
  const hasUser = trustees.some((name) => isUser(name, sid));
  if (!hasSystem || !hasUser || trustees.filter(isSystem).length !== 1) {
    return {
      ok: false,
      reason: "allowed trustees are not SYSTEM and this user",
    };
  }
  return { ok: true };
}

function isNetwork(trustee: string): boolean {
  return trustee === "NU" || trustee === "S-1-5-2";
}
function isSystem(trustee: string): boolean {
  return trustee === "SY" || trustee === "S-1-5-18";
}
function isUser(trustee: string, sid: string): boolean {
  if (trustee === sid.toUpperCase()) return true;
  // The built-in administrator account prints as its alias.
  return trustee === "LA" && /-500$/.test(sid);
}

/* ---------------------------------- helper --------------------------------- */

export const WINSEC_EXE_NAME = "armadra-winsec.exe";

/** Where a built `armadra-winsec.exe` can be, in the order they are tried. */
export function winsecCandidates(
  options: {
    readonly resourcesPath?: string | undefined;
    readonly execPath?: string;
    readonly moduleDir?: string;
  } = {},
): string[] {
  const candidates: string[] = [];
  const resources = options.resourcesPath ?? process.resourcesPath;
  if (resources !== undefined) {
    candidates.push(join(resources, "cli", WINSEC_EXE_NAME));
  }
  candidates.push(
    join(dirname(options.execPath ?? process.execPath), "cli", WINSEC_EXE_NAME),
  );
  // `out/core/main.js` → `out/cli/armadra-winsec.exe`, which
  // `pnpm --filter @armadra/desktop build` compiles on a Windows host.
  candidates.push(
    join(options.moduleDir ?? __dirname, "..", "cli", WINSEC_EXE_NAME),
  );
  return candidates;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The helper to run: `ARMADRA_WINSEC_EXE` (a file or nothing — never a guess at
 * another), else the built one next to the app.
 */
export function findWinsecExe(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = winsecCandidates(),
): string | undefined {
  const named = env.ARMADRA_WINSEC_EXE;
  if (named !== undefined) return isFile(named) ? named : undefined;
  return candidates.find(isFile);
}

/** Runs a program and resolves with its stdout; rejects on a non-zero exit. */
export type RunProgram = (
  file: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => Promise<string>;

const run: RunProgram = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = String(stderr).trim().split(/\r?\n/)[0] ?? "";
          reject(
            new Error(detail === "" ? error.message : detail, { cause: error }),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
  });

/**
 * The development fallback: Windows PowerShell 5.1 and the .NET pipe classes.
 * The pipe name and the descriptor travel in the environment, never in the
 * script text. Constrained Language Mode refuses `New-Object` of these types;
 * that is detected up front and reported as a failure, not worked around.
 */
export const POWERSHELL_HARDEN_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { [Console]::Error.WriteLine('constrained language mode'); exit 3 }
$name = $env:ARMADRA_PIPE_NAME
$rights = [System.IO.Pipes.PipeAccessRights]'ReadData,WriteData,ReadPermissions,ChangePermissions'
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Anonymous, [System.IO.HandleInheritability]::None)
try {
  $client.Connect(5000)
  $security = New-Object System.IO.Pipes.PipeSecurity
  $security.SetSecurityDescriptorSddlForm($env:ARMADRA_PIPE_SDDL, [System.Security.AccessControl.AccessControlSections]::Access)
  $client.SetAccessControl($security)
  [Console]::Out.WriteLine($client.GetAccessControl().GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access))
} finally { $client.Dispose() }
`;

export function systemPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(
    systemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export type HardenResult =
  | {
      readonly ok: true;
      readonly method: "exe" | "powershell";
      readonly sddl: string;
    }
  | { readonly ok: false; readonly reason: string };

export interface HardenPipeOptions {
  readonly sid?: string;
  readonly exe?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: RunProgram;
  readonly timeoutMs?: number;
}

/**
 * Replaces the DACL of the named pipe `pipePath` (`\\.\pipe\<name>`) and checks
 * the descriptor that reads back. The caller serves nothing on the pipe until
 * this resolves `ok`, and drops any connection accepted before that — the
 * helper's own connection is one of them.
 */
export async function hardenPipe(
  pipePath: string,
  options: HardenPipeOptions = {},
): Promise<HardenResult> {
  const env = options.env ?? process.env;
  const runner = options.run ?? run;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const prefix = "\\\\.\\pipe\\";
  if (!pipePath.startsWith(prefix) || pipePath.length === prefix.length) {
    return { ok: false, reason: "not a named pipe path" };
  }
  const name = pipePath.slice(prefix.length);
  let sid: string;
  try {
    sid = options.sid ?? currentSid();
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  const exe = "exe" in options ? options.exe : findWinsecExe(env);
  const attempt = async (
    method: "exe" | "powershell",
  ): Promise<HardenResult> => {
    try {
      const output =
        method === "exe"
          ? await runner(exe as string, ["harden-pipe", pipePath, sid], {
              env,
              timeoutMs,
            })
          : await runner(
              systemPowerShell(env),
              [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                POWERSHELL_HARDEN_SCRIPT,
              ],
              {
                env: {
                  ...env,
                  ARMADRA_PIPE_NAME: name,
                  ARMADRA_PIPE_SDDL: pipeSddl(sid),
                },
                timeoutMs,
              },
            );
      const sddl = output.trim().split(/\r?\n/).pop() ?? "";
      const verdict = verifyPipeSddl(sddl, sid);
      return verdict.ok
        ? { ok: true, method, sddl }
        : { ok: false, reason: verdict.reason };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  };
  if (exe !== undefined) {
    const first = await attempt("exe");
    if (first.ok) return first;
    // A helper that exists but fails (blocked, wrong arch) is not retried
    // through PowerShell: that would turn a policy block into a quiet bypass.
    return first;
  }
  return attempt("powershell");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
