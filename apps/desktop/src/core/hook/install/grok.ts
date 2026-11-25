import { CLIENT_NAME } from "./events";

/**
 * What a canvas Grok Build gets on its launch line (contract §123) — nothing
 * written to its configuration, `~/.grok` stays exactly as the user left it.
 *
 * Grok's interactive TUI has no per-process hook, plugin or MCP channel (its
 * `--plugin-dir` is an ACP-only flag, and the `GROK_CONFIG` overlay refuses
 * `hooks`, `plugins` and `mcp_servers`; both measured on 1.0.92). What it does
 * take per process is `--rules` (appended to the system prompt) and `--allow`
 * (permission rules), so:
 *
 *   * `--rules <one short sentence>` pointing at the skill file by its absolute
 *     path — the whole skill is read on demand, it is not on the command line;
 *   * the canvas verbs are shell commands (`armadra-hook canvas|context|browser
 *     …`), and `--allow` lets exactly those sub-commands through without a
 *     person: the same set `claude-allow.ts` allows for Claude.
 *
 * The rule syntax was measured on 1.0.92 (scripted model, isolated
 * `GROK_HOME`): `Bash(<abs path> canvas *)` lets `<abs path> canvas list` run
 * and nothing else — a chained `; touch x` / `&& …`, a `$(…)` or backtick
 * argument, a `>` redirect, a pipe, a quoted program path and another
 * sub-command all fall back to the normal approval prompt, with no side effect.
 * A bare-name rule matches only the bare-name command, so both spellings are
 * listed, the absolute one unquoted (a quoted path does not match).
 *
 * A data directory with a space in it (measured the same way): the unescaped,
 * unquoted rule `Bash(/a b/armadra-hook canvas *)` lets through both the
 * unescaped and the backslash-escaped command spelling; the rule written with
 * the backslash escape lets through neither, and a quoted command is not let
 * through by either. So the rule is emitted as is. The skill and `--rules` teach
 * the bare name `armadra-hook`, which the bare-name rules cover regardless of
 * where the data directory is.
 */
export const GROK_ALLOWED_SUBCOMMANDS = ["canvas", "context", "browser"];

export function grokAllowRules(clientBin: string): string[] {
  const rules: string[] = [];
  for (const sub of GROK_ALLOWED_SUBCOMMANDS) {
    rules.push(`Bash(${CLIENT_NAME} ${sub} *)`);
    if (clientBin !== CLIENT_NAME) rules.push(`Bash(${clientBin} ${sub} *)`);
  }
  return rules;
}

/** The launch-line argv: `--rules` when the skill is there, then every `--allow`. */
export function grokArgs(
  clientBin: string,
  instructions: string | undefined,
): string[] {
  return [
    // One line: a `.launch` word cannot hold a line break (Windows launcher).
    ...(instructions === undefined
      ? []
      : ["--rules", instructions.replace(/\s*\n+\s*/g, " ").trim()]),
    ...grokAllowRules(clientBin).flatMap((rule) => ["--allow", rule]),
  ];
}
