/**
 * The canvas tools as an MCP server for terminal Claude, OpenCode and Copilot.
 *
 * In the shell, `armadra-hook canvas …` runs under the user's own command
 * policy: a user who set OpenCode's `bash` to `ask`, and every Copilot, had a
 * person approve each verb (Copilot's terminal approval never reached the
 * board at all). Neither CLI can allow one sub-command of a binary without
 * widening the rest: OpenCode's `bash` patterns from the config content
 * replace the user's whole `bash` policy, and Copilot's shell rule matches only
 * the binary (`shell(armadra-hook:*)`). An MCP server has a name of its own to
 * allow, so the allow covers exactly the canvas tools — the same server and the
 * same requests as Codex's (`codex-mcp.ts`), with the same node token, so the
 * core grants nothing extra.
 *
 * Measured (contract §106.1): OpenCode 1.19.5 with a user `*: ask` runs
 * `armadra_canvas_list` without asking and still asks for `bash`; Copilot
 * 1.0.105 refuses the tool without `--allow-tool armadra` and runs it with it.
 * Both start the server with their own environment, so it finds the node the
 * shell would. Only on the launch line of a canvas node: nothing is written to
 * either CLI's configuration. ACP sessions do not get it — `session/new` gives
 * them the server with the session binding (`core/acp/mcp.ts`).
 *
 * Claude (contract §107): the server is started by Claude itself, outside the
 * Bash sandbox a user may turn on, where `armadra-hook` in the shell cannot
 * reach the core's socket. `--mcp-config` adds it to the user's servers (no
 * `--strict-mcp-config`), and the injected settings allow `mcp__armadra`, that
 * server's tools only.
 */

import { CODEX_MCP_NAME } from "./codex-mcp";

/** Every terminal CLI shows the tools under the same server name. */
export const TERMINAL_MCP_NAME = CODEX_MCP_NAME;

/**
 * What OpenCode's `OPENCODE_CONFIG_CONTENT` adds: the server, and an allow for
 * its tools (OpenCode names them `<server>_<tool>`). The `permission` object
 * merges into the user's, so their `bash` / `edit` / `*` rules stand.
 */
export function opencodeMcpConfig(clientBin: string): Record<string, unknown> {
  return {
    mcp: {
      [TERMINAL_MCP_NAME]: { type: "local", command: [clientBin, "mcp"] },
    },
    permission: { [`${TERMINAL_MCP_NAME}_*`]: "allow" },
  };
}

/** The file Claude's `--mcp-config <file>` reads. */
export function claudeMcpConfig(clientBin: string): Record<string, unknown> {
  return {
    mcpServers: {
      [TERMINAL_MCP_NAME]: { type: "stdio", command: clientBin, args: ["mcp"] },
    },
  };
}

/** Claude's permission rule for every tool of the server, and nothing else. */
export const CLAUDE_MCP_ALLOW = `mcp__${TERMINAL_MCP_NAME}`;

/** The file Copilot's `--additional-mcp-config @<file>` reads. */
export function copilotMcpConfig(clientBin: string): Record<string, unknown> {
  return {
    mcpServers: {
      [TERMINAL_MCP_NAME]: {
        type: "local",
        command: clientBin,
        args: ["mcp"],
        tools: ["*"],
      },
    },
  };
}

/** The server from `file`, and an allow for that server's tools only. */
export function copilotMcpArgs(file: string): string[] {
  return [
    "--additional-mcp-config",
    `@${file}`,
    "--allow-tool",
    TERMINAL_MCP_NAME,
  ];
}
