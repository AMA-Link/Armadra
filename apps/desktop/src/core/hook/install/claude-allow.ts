/**
 * What a canvas Claude runs without asking a person: the canvas MCP server's
 * tools (contract §107) and, for a Claude without it, the same verbs through
 * `armadra-hook` in the shell (contract §105.2). Both land in the injected
 * `--settings`, where they merge with the user's own rules.
 */

import { CLIENT_NAME } from "./events";
import { CLAUDE_MCP_ALLOW } from "./terminal-mcp";

/**
 * The `armadra-hook` sub-commands a canvas Claude may run without asking a
 * person — the canvas, context and browser verbs, the same ones the MCP
 * server exposes (and §98 already lets through in ACP sessions, and Codex's
 * `default_tools_approval_mode` on the terminal). Without these every verb was
 * a Bash approval.
 *
 * Measured on Claude 2.1.318 with `--settings`: the rules merge with the
 * user's own, match the bare name and the absolute path (quoted when it has a
 * space), and leave everything else to the user's permission mode — another
 * sub-command (`hook`, `mcp`), a chained `… && …` and the `"$ARMADRA_HOOK_BIN"`
 * spelling all still ask (contract §105.2).
 */
export const CLAUDE_ALLOWED_SUBCOMMANDS = ["canvas", "context", "browser"];

export function claudeAllowRules(clientBin: string): string[] {
  const absolute = clientBin.includes(" ") ? `"${clientBin}"` : clientBin;
  const rules: string[] = [];
  for (const sub of CLAUDE_ALLOWED_SUBCOMMANDS) {
    rules.push(`Bash(${CLIENT_NAME} ${sub}:*)`);
    if (absolute !== CLIENT_NAME) rules.push(`Bash(${absolute} ${sub}:*)`);
  }
  return rules;
}

/** The injected settings' `permissions`. */
export function claudePermissions(clientBin: string): { allow: string[] } {
  return { allow: [...claudeAllowRules(clientBin), CLAUDE_MCP_ALLOW] };
}
