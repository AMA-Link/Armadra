import {
  ACP_MODE_TABLE,
  type AcpModeMapping,
  type AgentRole,
  roleFlags,
} from "@armadra/shared";

import { type PermissionMode, PERMISSION_MODES } from "../agent/launch";
import {
  type AgentId,
  type AgentSettings,
  baseAgent,
  customAgent,
} from "../agent/registry";

/**
 * 七家 Agent 以 ACP 驱动时的启动与映射表（ACP 会话视图设计 §5.2，补全架构
 * §5.1 第 3 条）。
 *
 * 纯数据加两个纯函数，不起进程：程序在补齐过的 PATH 上找（`resolveCommand`，
 * 与终端驱动同一条规则），起进程在 `client.ts`，协商在 `host.ts`。
 *
 * `modes` 的键与 `agent/launch.ts` 的 `permissionFlag` 是同一个集合——
 * `adapters.test.ts` 守着。`null` 表示这家在 ACP 下没有这个模式，界面不出现，
 * 与设置页「只提供有对应参数的权限模式」同一规矩。
 */

/** 这家怎么说 ACP：自带入口、官方适配器、随包的桥（ama 的 `--bridge`）。 */
export const ACP_SUPPORT = ["native", "official", "bundled"] as const;
export type AcpSupport = (typeof ACP_SUPPORT)[number];

/** 跨进程接回用哪个方法；`none` = 只能新开（Copilot）。 */
export const ACP_RESUME = ["load", "resume", "none"] as const;
export type AcpResume = (typeof ACP_RESUME)[number];

/**
 * ACP `sessionId` 与 CLI 自己的会话 id 怎么对上（设计 §4.3）：
 * `same` 相等；`opaque` 对不上，读镜像。
 */
export const ACP_SESSION_ID = ["same", "opaque"] as const;
export type AcpSessionIdRule = (typeof ACP_SESSION_ID)[number];

/** 落点的形状与各家的表在 `@armadra/shared` 的 `ACP_MODE_TABLE`（页面与 core 共用）。 */
export type { AcpModeMapping };

/**
 * `session/new|load|resume` 的 `_meta`（ACP 规范留给各家自己的扩展位）的输入：
 * 会话层手里有、适配器可能要放进 `_meta` 的东西。只有适配器自己的
 * {@link AcpAdapter.sessionMeta} 知道哪个键放哪里——agy 把画布说明放进
 * `_meta.antigravity.systemPrompt.append`，别的 CLI 有别的形状；调用方不按
 * Agent 写分支。
 */
export interface AcpSessionMetaInput {
  readonly mode: PermissionMode;
  /** 画布说明（系统提示的追加文本）；没有就缺席。 */
  readonly instructions?: string;
  /** 要挂给这次会话的插件目录；没有就缺席。 */
  readonly pluginDirs?: readonly string[];
}

/** 一次 `_meta`：顶层键是各家自己的命名空间。 */
export type AcpSessionMeta = Readonly<Record<string, unknown>>;

export interface AcpAdapter {
  /** 内置 id；`ama` 在 core 的注册表补上之前单列（G1-7）。 */
  readonly agentId: AgentId | "ama";
  readonly support: AcpSupport;
  /** 在补齐过的 PATH 上找的程序名。 */
  readonly program: string;
  /** 程序之后固定的 argv。 */
  readonly args: readonly string[];
  /**
   * 固定 argv 里**必须排在最后**的那一段，放在模式 argv、注入 argv 之后。grok 的
   * `stdio` 是子命令，它的 `--always-approve`、`--plugin-dir` 这些选项要在它之前
   * （实测 `grok agent stdio --always-approve` 不认）。
   */
  readonly trailingArgs?: readonly string[];
  /**
   * 运行时才知道值的那个旗标：`ama --profile <path>`。给了 profile 路径才加，
   * 没给就不加（ama 自己用缺省 profile）。
   */
  readonly profileFlag?: string;
  readonly sessionId: AcpSessionIdRule;
  readonly resume: AcpResume;
  readonly modes: Readonly<Record<PermissionMode, AcpModeMapping | null>>;
  /**
   * 画布注入在 ACP 下还能用的那一半（设计 §5.8）。值（目录、令牌）由会话层
   * 从集成状态里取，这里只说用哪几条：
   *   * `mcp`：`session/new.mcpServers` 带 `armadra-hook mcp`；ama 走 profile
   *     的 host 适配器，不加，免得两套工具表；
   *   * `reuse`：终端启动器给的环境变量 / argv 照用；
   *   * `passthrough`：注入 argv 前面要隔一个 `--`（ama 的 pi 桥原样交给 pi）；
   *   * `mods`：Claude Code mod 经 `CLAUDE_CODE_PLUGIN_DIRS` 挂给适配器起的 CLI。
   */
  readonly injection: {
    readonly mcp: boolean;
    readonly reuse: readonly ("env" | "args")[];
    readonly passthrough?: "--";
    /**
     * `mcp` 的服务器不走 `session/new.mcpServers`、改成启动参数里的内联
     * 配置（Copilot：它在 ACP 下只收 http / sse，stdio 条目被丢弃，#858）。
     */
    readonly mcpViaArgs?: boolean;
    /**
     * 挂 Claude Code mod（契约 §59）：`CLAUDE_CODE_PLUGIN_DIRS` 指向 mod 目录、
     * `ARMADRA_MOD_PROFILE=acp`，门是适配器自带 CLI 的版本。mod 要靠节点身份
     * 找端点，所以这一家不预启动。
     */
    readonly mods?: boolean;
  };
  /**
   * 开会话时放进 `_meta` 的东西（见 {@link AcpSessionMetaInput}）。纯函数；
   * 答 `undefined` 或空对象就不带 `_meta`，线路与没有这个字段时逐字节相同。
   * 缺席 = 这家不用。
   */
  readonly sessionMeta?: (
    input: AcpSessionMetaInput,
  ) => AcpSessionMeta | undefined;
  /** 前台进程门认的 argv[0] basename（会话 pid 就是适配器 pid）。 */
  readonly expectedProcess: readonly string[];
  /**
   * 以 ACP 驱动时它怎么在画布上建 Agent（契约 §48）：`mcp` = `canvas_open_agent`
   * / `canvas_team` 两个 MCP 工具（`injection.mcp` 必须为真）；`runners` = ama 的
   * 宿主 `HostApi.runners`；`none` = 适配器不接 MCP，
   * 只有终端视图能建。
   */
  readonly canvasTools: AcpCanvasTools;
}

export const ACP_CANVAS_TOOLS = ["mcp", "runners", "none"] as const;
export type AcpCanvasTools = (typeof ACP_CANVAS_TOOLS)[number];

export const ACP_ADAPTERS: readonly AcpAdapter[] = [
  {
    agentId: "claude",
    support: "official",
    program: "claude-agent-acp",
    args: [],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.claude,
    // `--settings` / `--plugin-dir` / `--append-system-prompt-file` 在 ACP
    // 下没有对应参数（D6）：画布工具走 MCP；mod 经 SDK 宿主认的
    // `CLAUDE_CODE_PLUGIN_DIRS` 挂（只挂 mod，不挂技能插件），只带斜杠命令与
    // hello，状态仍由 ACP 会话写。`CLAUDE_CONFIG_DIR` 不设，沿用用户登录。
    injection: { mcp: true, reuse: [], mods: true },
    expectedProcess: ["claude-agent-acp"],
    canvasTools: "mcp",
  },
  {
    agentId: "codex",
    support: "official",
    program: "codex-acp",
    args: [],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.codex,
    injection: { mcp: true, reuse: ["env"] },
    expectedProcess: ["codex-acp"],
    canvasTools: "mcp",
  },
  {
    agentId: "opencode",
    support: "native",
    program: "opencode",
    args: ["acp"],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.opencode,
    injection: { mcp: true, reuse: ["env"] },
    expectedProcess: ["opencode"],
    canvasTools: "mcp",
  },
  {
    agentId: "pi",
    support: "bundled",
    // 随包的 ama 说 Pi 的 ACP（AMA-Link/Armadra#716）：会话 id 就是 Pi 的；
    // 不带 ama 的 profile，Pi 自己登录。
    program: "ama",
    args: ["--mode", "acp", "--bridge", "pi"],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.pi,
    // `--` 之后的参数桥原样交给 pi（技能、系统提示注入照用）；MCP 由桥交给
    // Pi 内置的 MCP，画布工具走 §48 的 `mcp`。
    injection: { mcp: true, reuse: ["args"], passthrough: "--" },
    expectedProcess: ["ama", "ama.cjs"],
    canvasTools: "mcp",
  },
  {
    agentId: "omp",
    support: "native",
    program: "omp",
    args: ["acp"],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.omp,
    injection: { mcp: true, reuse: ["args"] },
    expectedProcess: ["omp"],
    canvasTools: "mcp",
  },
  {
    agentId: "copilot",
    support: "native",
    program: "copilot",
    args: ["--acp", "--stdio"],
    sessionId: "opaque",
    resume: "none",
    // 三条旗标在 `--acp` 下是否生效待真跑核实（G3-7）。
    modes: ACP_MODE_TABLE.copilot,
    injection: { mcp: true, mcpViaArgs: true, reuse: ["args", "env"] },
    expectedProcess: ["copilot"],
    canvasTools: "mcp",
  },
  {
    agentId: "ama",
    support: "native",
    program: "ama",
    args: ["--mode", "acp"],
    profileFlag: "--profile",
    sessionId: "same",
    resume: "resume",
    // 模式 id 就是 ama 的权限模式（`@armadra/agent` docs/acp.md）。
    modes: ACP_MODE_TABLE.ama,
    injection: { mcp: false, reuse: [] },
    expectedProcess: ["ama", "ama.cjs"],
    canvasTools: "runners",
  },
  {
    agentId: "agy",
    support: "native",
    program: "agy",
    args: ["acp"],
    // 实跑核实（agy 1.5.16，2026-11-24）：ACP `sessionId` 就是 CLI 的会话 id
    //（对话库文件名、hook 的 `conversationId`）；`session/load` 与 `session/resume`
    // 都声明了，接回后 `currentModeId` 回到 `default`，由会话层重设模式。
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.agy,
    // 画布工具走 `session/new.mcpServers`（stdio 被接受、模型看得到工具）。终端注入
    // 在 `agy acp` 下没有对应物（没有 `--settings`；`--add-dir` 的零写入 hook 实测不可行，
    // 见契约 §120），所以不复用。画布说明（`_meta.antigravity.systemPrompt.append`）要等客户端能带
    // `_meta`（AMA-Link/armadra-agent#327）；在那之前不带 `sessionMeta`。
    injection: { mcp: true, reuse: [] },
    expectedProcess: ["agy"],
    canvasTools: "mcp",
  },
  {
    agentId: "grok",
    support: "native",
    program: "grok",
    // `--no-leader`：会话 pid 就是适配器 pid，也不被用户配置里的 `use_leader`
    // 带到共享的 leader 进程上；`stdio` 必须最后（见 `trailingArgs`）。
    args: ["agent", "--no-leader"],
    trailingArgs: ["stdio"],
    // 真账号实测（1.0.92）：`session/new` 的 sessionId 与会话目录名、hook 的
    // sessionId 是同一个 UUIDv7；`session/load`（回放历史）与 `session/resume` 都有。
    sessionId: "same",
    resume: "load",
    // 全自动走启动旗标 `--always-approve`；`_meta.yoloMode` 等 armadra-agent 的会话
    // `_meta` 通道，到时在这里加 `sessionMeta`。
    modes: ACP_MODE_TABLE.grok,
    // 画布工具走 stdio `mcpServers`（实测 `mcp_server_connected`）。规则、插件目录
    // 的 `_meta` 注入与终端的 `--rules` / `--allow` 在 G2 与 `_meta` 通道之后。
    injection: { mcp: true, reuse: [] },
    expectedProcess: ["grok", "grok-native"],
    canvasTools: "mcp",
  },
];

export function acpAdapter(agentId: string): AcpAdapter | undefined {
  return ACP_ADAPTERS.find((adapter) => adapter.agentId === agentId);
}

/**
 * 这一次开会话要带的 `_meta`；适配器不用、给的是空对象时答 `undefined`。
 * 空的命名空间也不带：`{ ns: {} }` 对 Agent 没有意义，却会改变线路。
 */
export function acpSessionMeta(
  adapter: AcpAdapter,
  input: AcpSessionMetaInput,
): AcpSessionMeta | undefined {
  const meta = adapter.sessionMeta?.(input);
  if (meta === undefined) return undefined;
  const entries = Object.entries(meta).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).length > 0;
    }
    return true;
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * 把一段系统提示追加文本放进 `_meta.<命名空间>.systemPrompt.append`，
 * 文本为空就什么都不放。agy 用它（`antigravity`）；别的 CLI 用别的键，自己写函数。
 */
export function systemPromptAppendMeta(
  namespace: string,
  text: string | undefined,
): AcpSessionMeta | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  return { [namespace]: { systemPrompt: { append: text } } };
}

/** 这家在 ACP 下真有落点的权限模式；`default` 总在。 */
export function acpPermissionModes(
  adapter: AcpAdapter,
): readonly PermissionMode[] {
  return PERMISSION_MODES.filter(
    (mode) => mode === "default" || adapter.modes[mode] !== null,
  );
}

export interface AcpLaunchOptions {
  readonly mode?: PermissionMode;
  /** ama 的 profile 路径（G1-7 的注入产物）。 */
  readonly profilePath?: string;
  /** 终端注入复用的 argv（`reuse` 含 `args` 时才用）。 */
  readonly injectionArgs?: readonly string[];
  /** 节点的角色（`agent.role`）：只有注册表给它配了旗标的 CLI 才加。 */
  readonly role?: AgentRole;
  /**
   * 调用方另有的 argv（Copilot 把 stdio MCP 服务器改成启动参数）。排在注入之后、
   * `trailingArgs` 之前：`stdio` 这类子命令必须最后。
   */
  readonly extraArgs?: readonly string[];
}

export interface AcpLaunchPlan {
  /** 程序之后的完整 argv（含末尾的 {@link trailingArgs}）。 */
  readonly args: readonly string[];
  /** `args` 末尾那段必须排最后的固定 argv；没有就缺席。 */
  readonly trailingArgs?: readonly string[];
  /** 起会话后要 `session/set_mode` 的 id；缺席 = 不调。 */
  readonly modeId?: string;
}

export type AcpLaunchError = {
  readonly code: "acp_mode_unsupported";
  readonly message: string;
};

/**
 * 一次启动的 argv 与模式 id。顺序：固定 argv → profile → 角色 → 模式 argv → 注入
 * （`passthrough` 的放最后，前面隔 `--`），再是 `trailingArgs`。没有落点的模式答错误而不是悄悄
 * 用缺省：一个说了 `plan` 却以可写模式起来的会话比起不来更糟。
 */
export function acpLaunchPlan(
  adapter: AcpAdapter,
  options: AcpLaunchOptions = {},
): AcpLaunchPlan | AcpLaunchError {
  const mode = options.mode ?? "default";
  const mapping = adapter.modes[mode];
  if (mapping === null) {
    return {
      code: "acp_mode_unsupported",
      message: `${adapter.agentId} has no ACP mapping for permission mode ${mode}`,
    };
  }
  const args = [...adapter.args];
  if (adapter.profileFlag !== undefined && options.profilePath !== undefined) {
    args.push(adapter.profileFlag, options.profilePath);
  }
  args.push(...roleFlags(adapter.agentId, options.role));
  args.push(...(mapping.args ?? []));
  const injection = adapter.injection.reuse.includes("args")
    ? (options.injectionArgs ?? [])
    : [];
  if (injection.length > 0) {
    if (adapter.injection.passthrough !== undefined) {
      args.push(adapter.injection.passthrough);
    }
    args.push(...injection);
  }
  args.push(...(options.extraArgs ?? []));
  const trailing = adapter.trailingArgs ?? [];
  args.push(...trailing);
  return {
    args,
    ...(trailing.length === 0 ? {} : { trailingArgs: trailing }),
    ...(mapping.modeId === undefined ? {} : { modeId: mapping.modeId }),
  };
}

/**
 * 这个 Agent 以 ACP 起时用哪一行适配器。`custom:` 条目借它基础 CLI 的；基础
 * CLI 自己就是 ACP 入口（`native`）时，条目的启动程序与参数顶替表里的程序——
 * 一个包装了 `opencode` 的自定义条目，它的 ACP 入口就是那个包装。
 */
export function adapterFor(
  settings: AgentSettings,
  agentId: string,
): AcpAdapter | undefined {
  const adapter = acpAdapter(baseAgent(settings, agentId));
  if (adapter === undefined) return undefined;
  const custom = customAgent(settings, agentId);
  if (custom === undefined || adapter.support !== "native") return adapter;
  return {
    ...adapter,
    program: custom.launchCmd,
    args: [...(custom.args ?? []), ...adapter.args],
    expectedProcess: [
      ...adapter.expectedProcess,
      custom.launchCmd.split(/[/\\]/).pop() ?? custom.launchCmd,
    ],
  };
}
