import { storedProbe } from "../../agent/probe";

/**
 * Version gates for the CLIs whose injection depends on the installed version
 * (Claude's mod, contract §57; Codex's session hooks). Split out of
 * `inject.ts`, which re-exports everything here, to keep that file inside the
 * repository's line budget.
 */

export function versionParts(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/* ------------------------------- Claude mods ------------------------------- */

/**
 * The first Claude Code whose `classic.*` events carry the settings hooks'
 * stdin shape (2.1.293 fixed them; 2.1.287–2.1.292 load mods but hand
 * `classic.PreToolUse` another shape). Contract §57.
 */
export const CLAUDE_MODS_MIN = "2.1.293";

/**
 * Releases on which the mod is known to misbehave: listing one closes the
 * gate for it without touching the generated module.
 */
export const CLAUDE_MODS_BROKEN: readonly string[] = [];

/**
 * What makes the launcher start Claude with the full settings hooks instead
 * of the mod, read in the node's own shell: safe mode loads no plugin at all,
 * and with nonessential traffic off the host refuses a plugin's every fetch.
 */
export const CLAUDE_MODS_FALLBACK_ENV = [
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

/** Why a canvas Claude starts without the mod (`agents.integration.mods.reason`). */
export type ClaudeModsReason =
  | "version_below_min"
  | "version_unknown"
  | "windows_launcher"
  | "remote_unprobed";

export interface ClaudeModsGate {
  readonly enabled: boolean;
  readonly reason: ClaudeModsReason | null;
}

/**
 * Whether a Claude Code of this version gets the mod. Unknown (not probed
 * yet, the probe failed, unparsable) answers no — the opposite of Codex's
 * gate: the settings hooks are the measured path, the mod the newer one, and
 * the probe answers within seconds of start-up.
 */
export function claudeLoadsMods(version: string | null | undefined): boolean {
  return claudeModsGate(version, { windows: false }).enabled;
}

/** The gate with its reason, as the integration state reports it. */
export function claudeModsGate(
  version: string | null | undefined,
  options: { readonly windows?: boolean; readonly remote?: boolean } = {},
): ClaudeModsGate {
  if (options.windows ?? process.platform === "win32") {
    // The Windows launcher is a `.launch` file of literal lines: it has no
    // branch for the environment fallback yet.
    return { enabled: false, reason: "windows_launcher" };
  }
  if (options.remote === true) {
    return { enabled: false, reason: "remote_unprobed" };
  }
  const have =
    version === undefined || version === null
      ? undefined
      : versionParts(version);
  if (have === undefined) return { enabled: false, reason: "version_unknown" };
  const need = versionParts(CLAUDE_MODS_MIN) as number[];
  if (CLAUDE_MODS_BROKEN.includes(have.join("."))) {
    return { enabled: false, reason: "version_below_min" };
  }
  for (let index = 0; index < need.length; index += 1) {
    const a = have[index] as number;
    const b = need[index] as number;
    if (a !== b) {
      return a > b
        ? { enabled: true, reason: null }
        : { enabled: false, reason: "version_below_min" };
    }
  }
  return { enabled: true, reason: null };
}

/** The built-in Claude's cached probe version, read only. */
export function probedClaudeVersion(): string | undefined {
  const probe = storedProbe("claude");
  return probe?.status === "ok" && probe.version !== null
    ? probe.version
    : undefined;
}
