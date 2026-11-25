/**
 * `session/new` 的 `mcpServers` 参数（ACP 设计 §5.8）：把 `armadra-hook mcp`
 * 交给经 ACP 驱动的 Agent，画布工具由它承担。
 *
 * 一条 stdio 服务器：命令是本机的 `armadra-hook`（`terminal/environment.ts`
 * 的 `hookClient()`，与终端里 PATH 上那个是同一个），参数 `["mcp"]`，环境变量
 * 与终端节点的注入同一份（`agentEnvironment`：节点 id、端点文件……，只有地址、
 * 不带令牌），会话绑定（`ARMADRA_SESSION_ID` / `_GENERATION`）有就加——
 * `canvas_ack` / `canvas_handoff_read` 要用。所以 core 分不出这条 MCP 与
 * `armadra-hook canvas` 的区别，也不多给权限。
 *
 * 客户端兼容：`@armadra/agent` 的 `AcpClient` 旧版开会话固定发
 * `mcpServers: []`，新版接受第三个参数 `{ mcpServers }` 并声明
 * `AcpClient.features.mcpServers`。{@link sessionOpener} 按这个声明选路：
 * 支持才带，不支持照旧开会话，并如实答 `mcpInjected: false`——缺了画布工具的
 * 会话照样能用，只是 Agent 不能动画布。
 */

import { AcpClient } from "@armadra/agent/acp";

import { agentEnvironment, hookClient } from "../terminal/environment";
import type { AcpAdapter, AcpSessionMeta } from "./adapters";
import type {
  AcpLoadSessionResult,
  AcpMcpServer,
  AcpNewSessionResult,
} from "./types";

/** MCP 服务器名：工具在 CLI 里显示为 `armadra` 这一组。 */
export const CANVAS_MCP_NAME = "armadra";

/**
 * stdio 的 MCP 服务器（ACP v1 每家都必须支持的那一种）。类型别名而不是
 * interface：要能赋给 `AcpMcpServer`（`Record<string, unknown>`）。
 */
export type AcpStdioMcpServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
};

export interface CanvasMcpInput {
  readonly nodeId: string;
  readonly agentId: string;
  readonly dataDir: string;
  readonly nodeName?: string;
  readonly nodeRole?: string;
  /** 会话行的 id 与代次：`canvas_ack` / `canvas_handoff_read` 的绑定。 */
  readonly session?: { readonly id: string; readonly generation: number };
  /** `armadra-hook` 的路径；缺省读 `hookClient()`。 */
  readonly hookBin?: string;
}

/**
 * 画布那条 MCP 服务器。本机没有 `armadra-hook`（源码检出没构建）时答
 * `undefined`：一条指向不存在程序的服务器会让有的 Agent 起会话就失败。
 */
export function canvasMcpServer(
  input: CanvasMcpInput,
): AcpStdioMcpServer | undefined {
  const command = input.hookBin ?? hookClient();
  if (command === undefined || command === "") return undefined;
  const env = agentEnvironment(
    input.nodeId,
    input.agentId,
    input.dataDir,
    input.nodeName,
    input.nodeRole,
  ).map(([name, value]) => ({ name, value }));
  if (input.session !== undefined) {
    env.push(
      { name: "ARMADRA_SESSION_ID", value: input.session.id },
      {
        name: "ARMADRA_SESSION_GENERATION",
        value: String(input.session.generation),
      },
    );
  }
  return { name: CANVAS_MCP_NAME, command, args: ["mcp"], env };
}

/**
 * 这家适配器开会话时带的 `mcpServers`：适配器表说不加（ama 走 profile 的
 * host 适配器，免得两套工具表）、没给输入或本机没有客户端时为空。
 */
export function acpMcpServers(
  adapter: Pick<AcpAdapter, "injection">,
  input: CanvasMcpInput | undefined,
): AcpStdioMcpServer[] {
  if (!adapter.injection.mcp || input === undefined) return [];
  const server = canvasMcpServer(input);
  return server === undefined ? [] : [server];
}

/**
 * Copilot 的 ACP 入口只收 http / sse 的 MCP 服务器，`session/new` 里的 stdio
 * 条目被它丢弃（日志 `Rejecting non-http/sse MCP server`，#858）。同一条服务器
 * 改成启动参数：`--additional-mcp-config <内联 JSON>` 加 `--allow-tool armadra`
 * （与终端的 `copilotMcpArgs` 同一套：`tools: ["*"]`、只放行这一台服务器）。
 * 环境变量写在配置的 `env` 里，是 `armadra-hook mcp` 的节点身份；只有地址，
 * 不带令牌。
 */
export function copilotAcpMcpArgs(server: AcpStdioMcpServer): string[] {
  const env: Record<string, string> = {};
  for (const { name, value } of server.env) env[name] = value;
  const config = {
    mcpServers: {
      [server.name]: {
        type: "local",
        command: server.command,
        args: [...server.args],
        env,
        tools: ["*"],
      },
    },
  };
  return [
    "--additional-mcp-config",
    JSON.stringify(config),
    "--allow-tool",
    server.name,
  ];
}

/** `AcpClient` 自己声明的可选能力；旧版没有 `features`，一律答不支持。 */
export function clientAcceptsMcpServers(
  client: { readonly features?: unknown } = AcpClient as {
    readonly features?: unknown;
  },
): boolean {
  const features = client.features as { mcpServers?: unknown } | undefined;
  return features?.mcpServers === true;
}

/**
 * `AcpClient` 能不能在开会话时带 `_meta`：声明 `features.sessionMeta`。固定的
 * 0.21 没有这个声明，一律答不支持——`_meta` 不发，会话照常开。
 *
 * 接口形状（`features.sessionMeta`、`AcpSessionOptions.meta`）由
 * AMA-Link/armadra-agent#327 定死；它落地并升级固定版本之前，这里的约定只是宿主
 * 一侧的预留，agy 批 1 的 ACP 部分与 grok G3 以它为前置。
 */
export function clientAcceptsSessionMeta(
  client: { readonly features?: unknown } = AcpClient as {
    readonly features?: unknown;
  },
): boolean {
  const features = client.features as { sessionMeta?: unknown } | undefined;
  return features?.sessionMeta === true;
}

/**
 * 适配器行带了 `_meta`、却没有随开会话发出去（`metaInjected === false`）：会话
 * 照常可用，但这家要的规则、插件目录或免审批开关没有生效，要留下一条记录。
 * 没带 `_meta` 的会话（`metaInjected` 缺席）答 `false`。
 */
export function sessionMetaDropped(session: {
  readonly metaInjected?: boolean;
}): boolean {
  return session.metaInjected === false;
}

/** 新版 `AcpClient` 开会话的第三个参数；`meta` 就是发给 Agent 的 `_meta`。 */
interface SessionCallOptions {
  readonly mcpServers: readonly AcpMcpServer[];
  readonly meta?: AcpSessionMeta;
}

/** 新版 `AcpClient` 开会话的签名（第三个参数）。 */
interface McpCapableClient {
  newSession(
    cwd: string,
    signal: AbortSignal | undefined,
    options: SessionCallOptions,
  ): Promise<AcpNewSessionResult>;
  loadSession(
    sessionId: string,
    cwd: string,
    signal: AbortSignal | undefined,
    options: SessionCallOptions,
  ): Promise<AcpLoadSessionResult>;
  resumeSession(
    sessionId: string,
    cwd: string,
    signal: AbortSignal | undefined,
    options: SessionCallOptions,
  ): Promise<AcpLoadSessionResult>;
}

/** 开会话用的三个方法，`mcpServers` 已按客户端能力决定带不带。 */
export interface AcpSessionOpener {
  newSession(cwd: string): Promise<AcpNewSessionResult>;
  loadSession(sessionId: string, cwd: string): Promise<AcpLoadSessionResult>;
  resumeSession(sessionId: string, cwd: string): Promise<AcpLoadSessionResult>;
  /** 要带的服务器真的随开会话发出去了。 */
  readonly mcpInjected: boolean;
  /** 要带的 `_meta` 真的随开会话发出去了（没有 `_meta` 要带时为 false）。 */
  readonly metaInjected: boolean;
}

/** {@link sessionOpener} 用到的那部分客户端（测试可以给一个记录调用的替身）。 */
export type AcpSessionClient = Pick<
  AcpClient,
  "newSession" | "loadSession" | "resumeSession"
>;

/**
 * 没有服务器与 `_meta` 要带、或客户端都不支持时，调用与旧版完全相同（不传第三个
 * 参数，线路逐字节不变）。`mcpServers` 与 `_meta` 各按自己的能力声明决定带不带：
 * 客户端只支持其中一样时，另一样不发，如实在 {@link AcpSessionOpener} 里答
 * `mcpInjected` / `metaInjected`。
 */
export function sessionOpener(
  client: AcpSessionClient,
  servers: readonly AcpMcpServer[] = [],
  supported: boolean = clientAcceptsMcpServers(),
  meta?: AcpSessionMeta,
  metaSupported: boolean = clientAcceptsSessionMeta(),
): AcpSessionOpener {
  const withServers = servers.length > 0 && supported;
  const withMeta = meta !== undefined && metaSupported;
  if (!withServers && !withMeta) {
    return {
      newSession: (cwd) => client.newSession(cwd),
      loadSession: (id, cwd) => client.loadSession(id, cwd),
      resumeSession: (id, cwd) => client.resumeSession(id, cwd),
      mcpInjected: false,
      metaInjected: false,
    };
  }
  const capable = client as unknown as McpCapableClient;
  const options: SessionCallOptions = {
    mcpServers: withServers ? servers : [],
    ...(withMeta ? { meta } : {}),
  };
  return {
    newSession: (cwd) => capable.newSession(cwd, undefined, options),
    loadSession: (id, cwd) => capable.loadSession(id, cwd, undefined, options),
    resumeSession: (id, cwd) =>
      capable.resumeSession(id, cwd, undefined, options),
    mcpInjected: withServers,
    metaInjected: withMeta,
  };
}
