/**
 * Builds `armadra-winsec.exe`, the Windows access-control helper
 * (`src/cli/armadra-winsec/winsec.cs`, contract §102.2).
 *
 * `node:net` makes a named pipe with a default security descriptor and has no
 * API to change it. The core runs this program right after it binds a private
 * pipe: it opens the pipe as a client with `WRITE_DAC`, replaces the DACL with
 * one that denies network logons and admits only SYSTEM and the current user,
 * and prints the descriptor it reads back, which the core checks before it
 * serves anything.
 *
 * Built with the same `csc.exe` as the hook launcher (`hook-launcher.mjs`), so
 * there is no native npm module and no new toolchain. Only a Windows host has
 * the compiler: `after-pack.mjs` builds it into a Windows package's resources,
 * and `pnpm --filter @armadra/desktop build` runs this file with `--if-windows`
 * so an unpackaged development tree on Windows has `out/cli/armadra-winsec.exe`
 * too. Without it the core falls back to Windows PowerShell 5.1 calling the
 * same .NET classes. The `dpapi-protect` / `dpapi-unprotect` subcommands (core
 * secret backend, contract §102.7) have no PowerShell fallback by decision.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileCSharp, findCsc } from "./hook-launcher.mjs";

const app = dirname(dirname(fileURLToPath(import.meta.url)));

/** The C# source, relative to `apps/desktop`. */
export const WINSEC_EXE_SOURCE = "src/cli/armadra-winsec/winsec.cs";

/** Where it goes in a packaged app, beside `cli/armadra-hook.exe`. */
export const WINSEC_EXE_RESOURCE = "cli/armadra-winsec.exe";

/** Assemblies beyond mscorlib that the helper needs. */
export const WINSEC_EXE_REFERENCES = ["System.Security.dll"];

/** Compiles the helper into `output` and returns its path. */
export function compileWinsecExe(
  output,
  { source = join(app, WINSEC_EXE_SOURCE), env = process.env, run } = {},
) {
  return compileCSharp(source, output, {
    env,
    name: "winsec-exe",
    // ProtectedData (the dpapi-* subcommands) lives in System.Security.dll.
    references: WINSEC_EXE_REFERENCES,
    ...(run === undefined ? {} : { run }),
  });
}

/**
 * What `node scripts/winsec-exe.mjs [--if-windows] [out]` does: off Windows
 * with `--if-windows` nothing, on Windows without a compiler a warning,
 * otherwise a compile whose failure fails. Returns the built path or
 * `undefined`.
 */
export function buildWinsecExe(
  argv,
  {
    host = process.platform,
    env = process.env,
    compile = compileWinsecExe,
    log = console.log,
  } = {},
) {
  const optional = argv.includes("--if-windows");
  const output =
    argv.find((arg) => !arg.startsWith("--")) ??
    join(app, "out", WINSEC_EXE_RESOURCE);
  if (optional && host !== "win32") return undefined;
  if (optional && findCsc({ env }) === undefined) {
    log(
      `winsec-exe: WARNING no csc.exe; ${WINSEC_EXE_RESOURCE} not built, private pipes are hardened through PowerShell`,
    );
    return undefined;
  }
  const built = compile(output, { env });
  log(`winsec-exe: built ${built}`);
  return built;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildWinsecExe(process.argv.slice(2));
}
