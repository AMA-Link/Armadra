/**
 * What state a shell starts in, before anything is asked (design §2, §4.1;
 * issue #288 §2 for the trust model below).
 *
 * The rule is the Rust shell's, restated for this shell:
 *
 *   **A build that carries nothing an update could be checked against says
 *   `notConfigured`.** It never says `upToDate`.
 *
 * "Something to check against" is either of two things:
 *
 * - the release signing public key (`resources/armadra-release.pub`, minisign,
 *   shipped in every package). Every downloaded bundle must then match the
 *   GitHub asset digest AND verify against its `<asset>.sig` with that key —
 *   with or without a platform code signature;
 * - a valid platform code signature, which electron-updater checks at install
 *   time. A package that has it but no public key keeps the old behaviour.
 *
 * Which installer runs is decided by `installPath`: a platform signature uses
 * electron-updater's own `quitAndInstall`; an unsigned macOS bundle is replaced
 * by a helper script, an unsigned Windows install re-runs the NSIS installer
 * silently; a Linux AppImage uses electron-updater. Packages a package manager
 * or a disk image owns (`managed.ts`) are `unsupported{managedPackage}`.
 *
 * The second half — `endpoints` — is where releases are published. Under
 * electron-builder that is the `publish` block, which lands in the packaged
 * app as `app-update.yml`; `ARMADRA_UPDATER_ENDPOINTS` overrides it, with the
 * comma-separated semantics `apps/desktop/scripts/signing.mjs:109-140` gave
 * the same variable.
 */

import type { MissingUpdaterConfig, Reason, UpdateState } from "./machine";
import type { ManagedKind } from "./managed";

/**
 * Whether this package carries a platform signature that makes an update
 * trustworthy.
 *
 * `notApplicable` is Linux: an AppImage carries no code signature, and what
 * makes its bytes trustworthy is the sha512 in the feed plus the sha256 the
 * Host published — both of which are checked whether or not anything is
 * signed.
 *
 * `unknown` is never treated as `signed`. Windows reads Authenticode
 * (`Get-AuthenticodeSignature`): `Valid` is `signed`, `NotSigned` is
 * `unsigned`, and anything else — a self-signed rehearsal certificate
 * included — is `unknown`. An `unsigned` or `unknown` package installs only
 * through the release key (`installPath`), never through electron-updater.
 */
export type SignatureState =
  | "signed"
  | "unsigned"
  | "notApplicable"
  | "unknown";

/**
 * The marker a LOCAL package carries in its packaged `package.json`, injected
 * by the `dist` script through electron-builder's `extraMetadata`. This is the
 * read side; W2.3 owns the write side.
 *
 * ### The contract W2.3 has to honour
 *
 * - key: `armadraUpdates`, value: the string `"disabled"`;
 * - injected by every local `dist*` script via `extraMetadata`, and by **no**
 *   release script, so a promoted build is untouched and keeps updating;
 * - read from `join(app.getAppPath(), "package.json")` at startup only.
 *
 * A locally packaged app is indistinguishable
 * from a release at runtime — `app.isPackaged` is true for both — so without
 * the marker it polls the production feed for a version that was never
 * published there and logs a `latest*.yml` 404 every check.
 *
 * The trade-off: a `dist`
 * package can no longer smoke-test the updater wiring. Verifying the real feed
 * is the job of a release package, which carries no marker; verifying the
 * wiring is the job of a local release server (`ARMADRA_UPDATES_DEV=1` plus
 * `ARMADRA_UPDATER_ENDPOINTS`), which needs no package at all.
 */
export const LOCAL_PACKAGE_MARKER = "armadraUpdates";
export const LOCAL_PACKAGE_DISABLED = "disabled";

export interface UpdaterEnvironment {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** The value of `armadraUpdates` in the packaged `package.json`, if any. */
  marker: unknown;
  /** Whether anything says where releases are published. */
  publishConfigured: boolean;
  signature: SignatureState;
  /** `ARMADRA_UPDATES_DEV=1`: a development escape hatch, and only that. */
  developmentOverride: boolean;
  /** `process.platform`. */
  platform: string;
  /**
   * The release signing public key this package carries (minisign text, already
   * parsed once), or `null` when it carries none.
   */
  pubkey: string | null;
  /** Who owns this installation, when it is not the shell (`managed.ts`). */
  managed: ManagedKind | null;
}

/** Which installer a staged update is handed to. */
export type InstallPath =
  /** electron-updater's `quitAndInstall` (platform signature, or AppImage). */
  | "electronUpdater"
  /** Unsigned macOS: a helper script replaces the `.app` after exit. */
  | "macReplace"
  /** Unsigned Windows: the NSIS installer, run silently, relaunches the app. */
  | "windowsInstaller";

/**
 * The installer for this installation, or `null` when nothing may install
 * here. A development (unpackaged) build is answered `electronUpdater`: it has
 * no package to replace, and electron-updater refuses on its own.
 */
export function installPath(
  environment: UpdaterEnvironment,
): InstallPath | null {
  if (!environment.packaged) return "electronUpdater";
  if (environment.managed !== null) return null;
  const signature = environment.signature;
  const keyed = environment.pubkey !== null;
  switch (environment.platform) {
    case "darwin":
      if (signature === "signed") return "electronUpdater";
      return keyed ? "macReplace" : null;
    case "win32":
      if (signature === "signed") return "electronUpdater";
      return keyed ? "windowsInstaller" : null;
    case "linux":
      return signature === "notApplicable" ? "electronUpdater" : null;
    default:
      return null;
  }
}

/**
 * Whether a downloaded bundle must verify against its `<asset>.sig`. Whenever
 * the package carries the key — signed or not, on every path.
 */
export function requiresDetachedSignature(
  environment: UpdaterEnvironment,
): boolean {
  return environment.pubkey !== null;
}

/**
 * Which half of the configuration is missing, in the wire shape the settings
 * page renders (`updates.missing.pubkey` / `updates.missing.endpoints`).
 */
export function missingUpdaterConfig(
  environment: UpdaterEnvironment,
): MissingUpdaterConfig {
  return {
    pubkey: !trustworthy(environment),
    endpoints: !environment.publishConfigured,
  };
}

/** Whether an installer may be handed bytes on this installation's say-so. */
export function installable(signature: SignatureState): boolean {
  return signature === "signed" || signature === "notApplicable";
}

/**
 * Why a staged update must not be installed here, or `null` when it may be.
 *
 * A package with neither the release key nor a platform signature may still
 * check, download and stage with `ARMADRA_UPDATES_DEV=1` — that is how the
 * path is walked without either — but it never installs: nothing it could
 * check the bytes against came with it. A development (unpackaged) build is
 * not judged here; it has no package to replace.
 */
export function installRefusal(environment: UpdaterEnvironment): Reason | null {
  if (!environment.packaged) return null;
  return installPath(environment) === null ? "notSigned" : null;
}

/** Whether anything about this build could make an update trustworthy. */
function trustworthy(environment: UpdaterEnvironment): boolean {
  // The escape hatch lets a development build talk to a loopback release
  // server; it is trustworthy only in the sense that the operator asked for
  // exactly this, and `installRefusal` still decides whether anything installs.
  if (environment.developmentOverride) return true;
  if (!environment.packaged) return false;
  return environment.pubkey !== null || installable(environment.signature);
}

/** Whether the local-package marker turns the updater off. */
export function markerDisables(marker: unknown): boolean {
  return (
    typeof marker === "string" &&
    marker.trim().toLowerCase() === LOCAL_PACKAGE_DISABLED
  );
}

/**
 * The state a shell starts in.
 *
 * The order matters, and it is the Rust shell's order: a build that could
 * verify nothing is "not configured" even on a development channel, because
 * that is the thing a person can actually do something about.
 */
export function initialState(environment: UpdaterEnvironment): UpdateState {
  const missing = missingUpdaterConfig(environment);
  // A local package is a build that never went through CI, whatever
  // `app.isPackaged` says about it.
  //
  // The marker is read BEFORE the missing-configuration rule, and only the
  // marker is: "not configured" exists because it names something a person can
  // go and fix, and for a marked package there is nothing to fix — a local
  // `dist` is unsigned by construction, so every such build would otherwise
  // report «no signing pubkey» and offer a settings link that changes nothing.
  // An unmarked build keeps the old order: it might really be a release whose
  // signing half is missing.
  if (markerDisables(environment.marker)) return { state: "localBuild" };
  // A disk image, a package manager or a portable copy owns this installation:
  // there is nothing the shell could replace, whatever it carries. The page
  // offers the matching installer instead (`managed.ts`).
  if (environment.packaged && environment.managed !== null) {
    return {
      state: "unsupported",
      reason: "managedPackage",
      managed: { package: environment.managed, download: null },
    };
  }
  if (missing.pubkey) return { state: "notConfigured", missing };
  if (!environment.packaged && !environment.developmentOverride) {
    return { state: "localBuild" };
  }
  if (missing.endpoints) return { state: "notConfigured", missing };
  return { state: "idle" };
}

/** Whether the updater should touch the network at all. */
export function shouldEnableUpdater(environment: UpdaterEnvironment): boolean {
  return initialState(environment).state === "idle";
}

/**
 * The endpoints `ARMADRA_UPDATER_ENDPOINTS` names, with the comma-separated
 * semantics of `apps/desktop/scripts/signing.mjs:109-140`. Empty when the
 * variable is unset, which is the ordinary case: the address then comes from
 * the Host's own artifact list at check time (design §2.2), and a value baked
 * into the repository would send a beta build to the stable manifest.
 */
export const ENDPOINTS_ENV = "ARMADRA_UPDATER_ENDPOINTS";

export function configuredEndpoints(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return (env[ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0);
}

/** `ARMADRA_UPDATES_DEV=1`, the same variable `updates/mod.rs:62-64` read. */
export function developmentOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ARMADRA_UPDATES_DEV === "1";
}
