/**
 * The canvas tools as an MCP server on a canvas Codex's launch line.
 *
 * Codex runs the model's shell commands in a sandbox that denies every
 * `connect()` (TCP and Unix sockets alike, `EPERM`), so `armadra-hook canvas …`
 * typed into that shell cannot reach the core. Codex 0.162 has no switch that
 * opens only one socket: `permissions.<profile>.network.unix_sockets` takes
 * effect only together with `network.enabled = true`, which opens *all*
 * outbound network (measured under `codex exec`: an external address connects),
 * and `sandbox_workspace_write.network_access` is the same all-or-nothing.
 * Neither is acceptable, and `danger-full-access` even less.
 *
 * An MCP server is the way out that widens nothing: Codex starts a stdio
 * server itself, outside the sandbox, and the model reaches it through tool
 * calls. `armadra-hook mcp` is the server ACP sessions already get
 * (`core/acp/mcp.ts`); it sends the same requests with the same node token, so
 * the core cannot tell it from `armadra-hook canvas` and grants nothing extra.
 *
 * Everything is on the launch line (`-c mcp_servers.armadra=…`): nothing is
 * written into `config.toml`, so a Codex started outside the board has no such
 * server.
 */

/** A TOML basic string; JSON's escapes are a subset TOML accepts. */
const tomlString = (value: string): string => JSON.stringify(value);

/** The server's name; Codex shows its tools as `armadra`'s. */
export const CODEX_MCP_NAME = "armadra";

/**
 * Codex starts an MCP server with a trimmed environment. These are forwarded
 * from Codex's own (the canvas terminal's) so the server finds the same node,
 * endpoint file and session binding the shell would. Names only; the values
 * are never put on the command line. The node token is not among them — the
 * server reads it from the token directory per call, as the shell client does.
 */
export const CODEX_MCP_ENV_VARS: readonly string[] = [
  "ARMADRA_NODE_ID",
  "ARMADRA_AGENT_ID",
  "ARMADRA_NODE_NAME",
  "ARMADRA_NODE_ROLE",
  "ARMADRA_ENDPOINT_FILE",
  "ARMADRA_CANVAS_CONTROL",
  "ARMADRA_SESSION_ID",
  "ARMADRA_SESSION_GENERATION",
  "ARMADRA_DATA_DIR",
  "ARMADRA_NODE_TOKEN_DIR",
  "ARMADRA_HOOK_SOCK",
  "ARMADRA_HOOK_PORT",
  "ARMADRA_HOOK_VERSION",
];

/**
 * The two `-c` overrides for the server: its definition and auto-approval of
 * its tools. The shell command the tools replace runs inside the sandbox
 * without a prompt; a prompt per canvas tool call would make the board
 * unusable and gain nothing, since the core grants the same rights either way.
 */
export function codexMcpArgs(clientBin: string): string[] {
  const vars = CODEX_MCP_ENV_VARS.map(tomlString).join(",");
  return [
    "-c",
    `mcp_servers.${CODEX_MCP_NAME}={command=${tomlString(clientBin)},args=["mcp"],env_vars=[${vars}],default_tools_approval_mode="approve"}`,
  ];
}
