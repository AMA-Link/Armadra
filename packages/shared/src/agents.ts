import { z } from "zod";

import {
  PERMISSION_MODES,
  permissionModeSchema,
  type PermissionMode,
} from "./domain/primitives.js";
import {
  posixQuote,
  shellCommandLine,
  type LaunchWord,
  type ShellDialect,
} from "./shell.js";

/**
 * Agent registry — see docs/contracts/v3-agent-terminal-plan.md §5.1.
 *
 * Pure data plus one pure function. An "agent" is a CLI that we start inside a
 * terminal node; nothing here spawns a process, and the runtime keeps only a
 * mirror of the ids and launch programs .
 */

export const AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
  "ama",
  "agy",
  "grok",
] as const;
export type BuiltinAgentId = (typeof AGENT_IDS)[number];

/**
 * 内置 Agent 里**没有**画布注入的那几家（契约 §120）：没有单次生效的 hook /
 * 技能通道，Armadra 不为它们写任何文件。其余都在 core 的注入名单
 * （`core/hook/install/inject.ts::INJECTED_AGENTS`）里，两边由 core 的测试守着一致。
 * 新增一家内置 Agent 时，没有注入就加在这里——零注入开关等只对有注入的家有意义的
 * 派生表据此排除它。
 */
export const NON_INJECTED_AGENT_IDS = [
  "agy",
  // grok：G2 才有注入（`--rules` 与 `--allow`，不写它的任何文件）；之前启动不带
  // Armadra 的任何东西。
  "grok",
] as const satisfies readonly BuiltinAgentId[];
export type NonInjectedAgentId = (typeof NON_INJECTED_AGENT_IDS)[number];
export type InjectedAgentId = Exclude<BuiltinAgentId, NonInjectedAgentId>;

/** 有画布注入的内置 Agent，注册表顺序。 */
export function injectedAgentIds(
  all: readonly string[] = AGENT_IDS,
  without: readonly string[] = NON_INJECTED_AGENT_IDS,
): readonly string[] {
  return all.filter((id) => !without.includes(id));
}

/**
 * How the first prompt reaches the CLI:
 * - `argv`               positional argument on the launch line
 * - `flag-prompt`        passed through a dedicated flag (`promptFlag`)
 * - `stdin-after-start`  typed into the TUI once it is up (never on the line)
 */
export const PROMPT_MODES = [
  "argv",
  "flag-prompt",
  "stdin-after-start",
] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

/**
 * What an adapter can do, as a composed set rather than a per-CLI branch in
 * every component (docs/design/agent-automation-design.md §1).
 *
 * The three later entries were added with the M2 capability work:
 *
 *   * `nativeRecurrence` — the CLI runs loops/cron of its own that we can
 *     *observe*. No built-in adapter claims it yet: none of the built-ins exposes a
 *     readable job list, and §1 forbids inferring a capability from a name. The
 *     vocabulary exists so an adapter that gains one can declare it.
 *   * `structuredInputAck` — a delivered prompt can be tied back to the turn it
 *     produced, which is what §5 rule 5 needs before a dispatch may be called
 *     delivered. Only the four hook adapters have that channel.
 *   * `supportsModelSelection` — the CLI takes a model on its launch line, so
 *     the node header may offer one. Every built-in has a `modelFlag`, but the
 *     capability is still narrowed by version probing and the execution host.
 *   * `browser` — the adapter may drive a controlled browser session (B01,
 *     docs/design/editor-browser-design.md §7). The verb travels the same hook client
 *     channel as `contextLink`, so every adapter with a link has it too; the
 *     grant is still checked per action, the capability only says the channel
 *     exists.
 */
export const AGENT_CAPABILITIES = [
  "hooks",
  "resume",
  "subagent",
  "contextLink",
  "browser",
  "usage",
  "nativeRecurrence",
  "structuredInputAck",
  "supportsModelSelection",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * A node's role on the canvas (docs/design/coordinator-agent.md §4). Only
 * `coordinator` exists: the node dispatches work to members and runs nothing
 * itself. Absent means a regular member with the CLI's own tool set.
 */
export const AGENT_ROLES = ["coordinator"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentDefinition {
  readonly id: BuiltinAgentId;
  readonly label: string;
  /**
   * Two-character type mark drawn in the node header (Armadra#969). Initials
   * alone collide (Claude Code / Codex / Copilot), so each agent names its own.
   */
  readonly mark: string;
  /** Brand colour — plan §3.4. */
  readonly color: string;
  /** Program name looked up on the augmented PATH. */
  readonly launchCmd: string;
  readonly promptMode: PromptMode;
  /** Only meaningful when `promptMode === "flag-prompt"`. */
  readonly promptFlag?: string;
  /**
   * 只在 `promptMode === "argv"` 时有意义：第一个 prompt 前要不要隔一个 `--`。
   * 为 grok 加的：它的 prompt 是位置参数，整条 prompt 恰好等于一个子命令名
   * （`version`、`update`）或以 `-` 开头时会被当成子命令或旗标；`--` 之后全部是
   * prompt。以它为 base 的自定义条目继承。
   */
  readonly promptSeparator?: "--";
  /** Permission mode → extra argv. An empty list means "CLI default". */
  readonly permissionFlag: Readonly<Record<PermissionMode, readonly string[]>>;
  readonly modelFlag?: string;
  /** 工作流档位的参数（只有 ama）。 */
  readonly tierFlag?: string;
  /**
   * Role → extra argv. A role this CLI has no entry for is ignored: the role
   * shapes what the agent may do, and only a CLI that can enforce it says so.
   */
  readonly roleFlag?: Readonly<Partial<Record<AgentRole, readonly string[]>>>;
  /**
   * The role a node of this CLI gets when the user creates it from the add
   * menu. Members opened by another agent (`open-agent`, team, runners) never
   * get one.
   */
  readonly defaultRole?: AgentRole;
  /** Set when we may pre-mint the session id instead of learning it from a hook. */
  readonly sessionIdFlag?: string;
  /**
   * How this CLI is told to continue an existing session (plan §17). A flag
   * (`--resume`) is appended after the program; `"positional"` means the id
   * follows a bare subcommand that has to come before every flag, which is
   * codex's shape (`codex resume <id> --model …`). Absent = cannot resume.
   */
  readonly resume?:
    | { readonly style: "flag"; readonly flag: string }
    | { readonly style: "positional"; readonly verb: string };
  /**
   * The CLI's own quit command, typed into its prompt before an Eco sleep ends
   * the session (terminal host design §7.2): a CLI that quits itself writes
   * its session state out, which is what `resume` reads back. Absent = the
   * process is simply ended.
   */
  readonly exitCommand?: string;
  readonly capabilities: readonly AgentCapability[];
  /** argv[0] basenames accepted when checking that a PTY still runs this agent. */
  readonly expectedProcess: readonly string[];
}

export const AGENT_REGISTRY: Readonly<Record<BuiltinAgentId, AgentDefinition>> =
  {
    claude: {
      id: "claude",
      label: "Claude Code",
      mark: "CC",
      color: "#d97757",
      launchCmd: "claude",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--permission-mode", "acceptEdits"],
        "full-auto": ["--dangerously-skip-permissions"],
        plan: ["--permission-mode", "plan"],
      },
      modelFlag: "--model",
      sessionIdFlag: "--session-id",
      resume: { style: "flag", flag: "--resume" },
      exitCommand: "/exit",
      capabilities: [
        "hooks",
        "resume",
        "subagent",
        "contextLink",
        "browser",
        "usage",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["claude"],
    },
    codex: {
      id: "codex",
      label: "Codex",
      mark: "CX",
      color: "#10a37f",
      launchCmd: "codex",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--full-auto"],
        "full-auto": ["--dangerously-bypass-approvals-and-sandbox"],
        plan: ["--sandbox", "read-only"],
      },
      modelFlag: "--model",
      resume: { style: "positional", verb: "resume" },
      exitCommand: "/quit",
      capabilities: [
        "hooks",
        "resume",
        "subagent",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["codex"],
    },
    opencode: {
      id: "opencode",
      label: "OpenCode",
      mark: "OC",
      color: "#a78bfa",
      launchCmd: "opencode",
      promptMode: "flag-prompt",
      promptFlag: "--prompt",
      permissionFlag: {
        default: [],
        "auto-edit": [],
        "full-auto": [],
        plan: [],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--session" },
      exitCommand: "/exit",
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["opencode"],
    },
    pi: {
      id: "pi",
      label: "Pi",
      mark: "Pi",
      color: "#e8b86d",
      launchCmd: "pi",
      promptMode: "argv",
      // Pi has no built-in approval/plan flag. Preserve its own tool policy.
      permissionFlag: {
        default: [],
        "auto-edit": [],
        "full-auto": [],
        plan: [],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--session" },
      exitCommand: "/quit",
      // Pi has no command hooks; its status source is an in-process TS
      // extension on the same `hook.sock`, which is the same three layers of
      // authentication over a different transport
      // (docs/design/agent-collaboration-channels.md §3.1 channel B). So
      // `hooks` here means "there is a status source", not "there is a
      // `hooks` key in a settings file".
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["pi"],
    },
    omp: {
      id: "omp",
      label: "Oh My Pi",
      mark: "OM",
      color: "#d4a373",
      launchCmd: "omp",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--approval-mode", "write"],
        "full-auto": ["--approval-mode", "yolo"],
        // --plan selects a model; --plan-yolo auto-approves execution. Neither
        // is an equivalent of a persistent read-only plan permission mode.
        plan: [],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--resume" },
      exitCommand: "/exit",
      // Same extension API as Pi, under `~/.omp/agent/extensions/`.
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["omp"],
    },
    copilot: {
      id: "copilot",
      label: "GitHub Copilot",
      mark: "GH",
      color: "#a371f7",
      launchCmd: "copilot",
      promptMode: "flag-prompt",
      promptFlag: "--interactive",
      permissionFlag: {
        default: [],
        "auto-edit": ["--allow-tool=write"],
        "full-auto": ["--allow-all"],
        plan: ["--plan"],
      },
      modelFlag: "--model",
      resume: { style: "flag", flag: "--resume" },
      exitCommand: "/exit",
      // Copilot's status source is a command hook like Claude's, written to
      // `~/.copilot/hooks/armadra.json`.
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      expectedProcess: ["copilot"],
    },
    ama: {
      id: "ama",
      label: "Armadra Agent",
      mark: "AM",
      color: "#2f6fed",
      launchCmd: "ama",
      promptMode: "argv",
      permissionFlag: {
        default: [],
        "auto-edit": ["--permission-mode", "auto-edit"],
        "full-auto": ["--permission-mode", "full-auto"],
        plan: ["--permission-mode", "plan"],
      },
      modelFlag: "--model",
      tierFlag: "--tier",
      // ama's own preset for the canvas coordinator: read plus the host's
      // canvas tools, no bash / edit / write, and codemode cannot reach past
      // it (`@armadra/agent` src/tools/presets.ts).
      roleFlag: { coordinator: ["--tools-preset", "coordinator"] },
      defaultRole: "coordinator",
      sessionIdFlag: "--session-id",
      resume: { style: "flag", flag: "--resume" },
      exitCommand: "/exit",
      // Our own agent (docs/design/coordinator-agent.md §2.2). No `subagent`:
      // the canvas rules want it to open sibling nodes (`canvas open-agent` /
      // team) rather than hide work inside its own process.
      capabilities: [
        "hooks",
        "resume",
        "contextLink",
        "browser",
        "usage",
        "structuredInputAck",
        "supportsModelSelection",
      ],
      // The launcher execs into the bundled runtime, so tmux's
      // `pane_current_command` sees the runner rather than `ama`.
      expectedProcess: [
        "ama",
        "ama.cjs",
        "armadra",
        "Armadra",
        "Electron",
        "electron",
      ],
    },
    agy: {
      id: "agy",
      label: "Antigravity",
      mark: "AG",
      color: "#d6418b",
      launchCmd: "agy",
      promptMode: "flag-prompt",
      promptFlag: "--prompt-interactive",
      permissionFlag: {
        // The user's own `agentMode` decides (auto since 1.5.7); no `--mode default`.
        default: [],
        "auto-edit": ["--mode", "accept-edits"],
        "full-auto": ["--dangerously-skip-permissions"],
        plan: ["--mode", "plan"],
      },
      modelFlag: "--model",
      // No `sessionIdFlag` and no `resume`: agy cannot pre-mint a session id
      // (an unknown `--conversation` is ignored and a new one starts), and a
      // terminal agy has no status source to learn the id from. Resume is an
      // ACP matter (`session/load`) until the hook lands
      // (#997, the hook batch).
      exitCommand: "/exit",
      // No hook, no resume, no usage: its terminal state is OSC 7501 (display
      // only, contract §53). `contextLink` and `browser` are the node's links
      // and the canvas verbs, which a session driven over ACP carries through
      // the MCP server; the real run of e2e scenario 12 showed that without
      // `contextLink` an ACP agy node is refused every `canvas send`.
      capabilities: ["contextLink", "browser", "supportsModelSelection"],
      expectedProcess: ["agy"],
    },
    grok: {
      id: "grok",
      label: "Grok Build",
      mark: "Gk",
      color: "#a1a1aa",
      launchCmd: "grok",
      promptMode: "argv",
      // 首个 prompt 是位置参数：整条 prompt 恰好是子命令名（`version`）或以 `-`
      // 开头会被 clap 当子命令 / 旗标，所以前面隔一个 `--`（`--` 之后全是 prompt）。
      promptSeparator: "--",
      permissionFlag: {
        // 留空 = 沿用用户自己的配置；TUI 缺省是 auto-review，不是逐次询问。
        default: [],
        "auto-edit": ["--permission-mode", "acceptEdits"],
        "full-auto": ["--always-approve"],
        plan: ["--permission-mode", "plan"],
      },
      modelFlag: "--model",
      sessionIdFlag: "--session-id",
      resume: { style: "flag", flag: "--resume" },
      exitCommand: "/quit",
      // 没有 `hooks`：状态源（按进程读它自己写的会话文件）与注入在 G2，那时才声明
      // `hooks`、`contextLink`、`browser`。`subagent` 不给：它有自己的
      // `spawn_subagent`，但没有读卡通道。
      capabilities: ["resume", "supportsModelSelection"],
      // npm 包的 `grok` 是指向 `grok-native` 的链接，经它或 `~/.grok/bin/grok`
      // 起，前台进程名都是 `grok`；自更新重启成 `grok-<版本>` 的情形待核实。
      expectedProcess: ["grok", "grok-native"],
    },
  };

export const AGENT_LIST: readonly AgentDefinition[] = AGENT_IDS.map(
  (id) => AGENT_REGISTRY[id],
);

export function isAgentId(value: unknown): value is BuiltinAgentId {
  return (
    typeof value === "string" &&
    (AGENT_IDS as readonly string[]).includes(value)
  );
}

export function agentDefinition(id: string): AgentDefinition | undefined {
  return isAgentId(id) ? AGENT_REGISTRY[id] : undefined;
}

/** Only expose permission modes backed by a real CLI argument. */
export function supportedPermissionModes(
  agentId: string,
): readonly PermissionMode[] {
  const definition = agentDefinition(agentId);
  return PERMISSION_MODES.filter(
    (mode) =>
      mode === "default" || (definition?.permissionFlag[mode].length ?? 0) > 0,
  );
}

/** The argv a role adds for this built-in; none when the CLI has no such role. */
export function roleFlags(
  agentId: string,
  role: AgentRole | undefined,
): readonly string[] {
  if (role === undefined) return [];
  return agentDefinition(agentId)?.roleFlag?.[role] ?? [];
}

/** The role a new node of this built-in starts with (the add menu's). */
export function defaultAgentRole(agentId: string): AgentRole | undefined {
  return agentDefinition(agentId)?.defaultRole;
}

/**
 * Environment variable name. The runtime enforces the same shape and drops
 * anything else , including the `ARMADRA_*` names
 * the hook client owns — a custom agent must not be able to redirect its own
 * hook reports.
 */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const MAX_ENV_VALUE = 4_096;

export const customAgentEnvSchema = z.record(
  z
    .string()
    .regex(ENV_KEY_PATTERN)
    .refine((key) => !key.startsWith("ARMADRA_"), {
      message: "ARMADRA_* is reserved for the hook client",
    }),
  z.string().max(MAX_ENV_VALUE),
);

/** A user-defined CLI that borrows a built-in agent's hook adapter. */
export const customAgentSchema = z.object({
  id: z.string().regex(/^custom:[A-Za-z0-9._:-]{1,64}$/),
  label: z.string().min(1).max(80),
  color: z.string().min(1).max(32).default("#a78bfa"),
  launchCmd: z.string().min(1).max(1_024),
  args: z.array(z.string().max(1_024)).max(64).default([]),
  /**
   * Extra environment for the PTY, merged by the runtime when the terminal is
   * created — never written onto the launch line, where it would end up in the
   * user's shell history. Values may reference the runtime's own environment
   * with `${env:VAR}` / `${env:VAR:fallback}`.
   */
  env: customAgentEnvSchema.optional(),
  /** Which built-in agent's hook/prompt behaviour this custom entry reuses. */
  baseAgent: z.enum(AGENT_IDS).default("claude"),
  disabledCapabilities: z
    .array(z.enum(AGENT_CAPABILITIES))
    .max(AGENT_CAPABILITIES.length)
    .optional(),
  promptMode: z.enum(PROMPT_MODES).optional(),
  permissionMode: permissionModeSchema.optional(),
});

export type CustomAgent = z.infer<typeof customAgentSchema>;

export function inheritedAgentCapabilities(
  custom: Pick<CustomAgent, "baseAgent" | "disabledCapabilities">,
): readonly AgentCapability[] {
  const base = agentDefinition(custom.baseAgent);
  return (
    base?.capabilities.filter(
      (capability) => !custom.disabledCapabilities?.includes(capability),
    ) ?? []
  );
}

/* ------------------------------ launch line ------------------------------ */

export interface AssembleLaunchCommandInput {
  agentId: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  /** 工作流档位；只有带 `tierFlag` 的 CLI 进 argv，`model` 同给时 `model` 优先。 */
  tier?: string;
  /** The node's role; argv only for a CLI with a `roleFlag` for it. */
  role?: AgentRole;
  sessionId?: string;
  /**
   * Continue an existing session instead of starting a new one — the id comes
   * from the conversations index (`GET /api/conversations`). Ignored by agents
   * without a `resume` entry, and it wins over `sessionId`: pre-minting an id
   * and reopening one are mutually exclusive requests.
   */
  resume?: string;
  /** Absolute path or alternative program from settings; replaces `launchCmd`. */
  programOverride?: string;
  /**
   * Words the program itself needs in front of the CLI's argv — the script
   * when an npm wrapper on Windows is started as `node.exe <cli.js>` (the
   * row's `launchTarget`), and, when the program is the canvas launcher
   * (the row's `launcher`), the CLI's program before them. Only on the typed
   * line: a frozen plan names the agent, and its executor resolves the
   * program on its own machine.
   */
  programArgs?: readonly string[];
  /**
   * The dialect of the shell the line is typed into (`shellDialect` of the
   * node terminal's shell). POSIX when absent.
   */
  dialect?: ShellDialect;
  /** Prompt/permission behaviour to use when `agentId` is a `custom:` id. */
  baseAgent?: BuiltinAgentId;
  /**
   * The `settings.agents.custom[]` entry `agentId` names. It supplies the
   * program and the leading extra argv, and its `baseAgent` decides how the
   * prompt, the permission mode and resuming are expressed.
   *
   * Its `env` is deliberately *not* used here: the launch line is typed into a
   * shell, so a `VAR=value` prefix would land in the user's shell history. The
   * runtime merges it into the PTY environment instead.
   */
  custom?: CustomAgent;
}

export interface LaunchCommand {
  /** The single line written into the shell followed by Enter. */
  command: string;
  /**
   * Prompt that must be typed into the CLI *after* it is ready
   * (`promptMode: "stdin-after-start"`), never part of `command`.
   */
  stdinPrompt?: string;
}

/** POSIX single-quote escaping: `it's` → `'it'\''s'`. */
export const shellQuote = posixQuote;

/**
 * The prompt is *typed into a shell*, not exec'd, so it must be a single line;
 * newlines and other control characters collapse to spaces.
 */
export function collapsePrompt(prompt: string): string {
  return (
    prompt
      // eslint-disable-next-line no-control-regex -- 有意匹配控制字符以拒绝或剥离它们
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The launch line before it is turned into shell text: the program and the
 * argv that follows it, each value exactly as the CLI should receive it.
 *
 * This is the shape a background scheduler freezes into a plan. It stores the
 * argv and nothing else, so the executor resolves the program from the agent
 * id against its own registry and a stored plan can never become "run this
 * binary". Quoting is a property of writing into a shell, not of the launch.
 */
export interface LaunchArgv {
  program: string;
  args: string[];
  stdinPrompt?: string;
}

/**
 * Build the launch argv for an agent node. Order: program → permission mode →
 * model → role → pre-minted session id → extra args → prompt (plan §5.1).
 */
export function assembleLaunchArgv(
  input: AssembleLaunchCommandInput,
): LaunchArgv {
  const custom = input.custom;
  const base = input.agentId.startsWith("custom:")
    ? custom?.baseAgent || input.baseAgent
      ? AGENT_REGISTRY[custom?.baseAgent ?? input.baseAgent!]
      : undefined
    : agentDefinition(input.agentId);
  if (!base) {
    throw new Error(`Unknown agent id: ${input.agentId}`);
  }

  const program = (
    input.programOverride ??
    custom?.launchCmd ??
    base.launchCmd
  ).trim();
  if (!program) {
    throw new Error(`Agent ${input.agentId} has no launch program`);
  }

  const args: string[] = [];

  // Resume comes before everything else. Codex's `resume` is a subcommand, and
  // a subcommand that follows a flag is a parse error; the flag-style CLIs do
  // not care where it sits, so one position serves all three.
  const resumeId = input.resume?.trim();
  if (resumeId && custom?.disabledCapabilities?.includes("resume")) {
    throw new Error("Session resume is disabled for this custom agent");
  }
  const resume = resumeId ? base.resume : undefined;
  if (resumeId && resume) {
    args.push(resume.style === "positional" ? resume.verb : resume.flag);
    args.push(resumeId);
  }

  const permissionMode = input.permissionMode ?? "default";
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`Unknown permission mode: ${permissionMode}`);
  }
  if (!supportedPermissionModes(base.id).includes(permissionMode)) {
    throw new Error(
      `${base.label} does not support permission mode: ${permissionMode}`,
    );
  }
  args.push(...base.permissionFlag[permissionMode]);

  if (input.model && base.modelFlag) {
    args.push(base.modelFlag, input.model);
  }
  if (input.tier && base.tierFlag && !input.model) {
    args.push(base.tierFlag, input.tier);
  }

  args.push(...roleFlags(base.id, input.role));

  // `--session-id` mints a new session; asking for both is a contradiction and
  // claude rejects the pair outright, so resume silently wins.
  if (input.sessionId && base.sessionIdFlag && !(resumeId && resume)) {
    args.push(base.sessionIdFlag, input.sessionId);
  }

  // The custom entry's own argv: it is part of how that program is invoked
  // (`npx -y my-cli`).
  args.push(...(custom?.args ?? []));

  const prompt = input.prompt ? collapsePrompt(input.prompt) : "";
  let stdinPrompt: string | undefined;
  if (prompt) {
    switch (custom?.promptMode ?? base.promptMode) {
      case "argv":
        if (base.promptSeparator !== undefined) args.push(base.promptSeparator);
        args.push(prompt);
        break;
      case "flag-prompt":
        args.push(base.promptFlag ?? "--prompt", prompt);
        break;
      case "stdin-after-start":
        stdinPrompt = prompt;
        break;
    }
  }

  return { program, args, ...(stdinPrompt ? { stdinPrompt } : {}) };
}

/**
 * The same launch as one line of shell text, quoted for `input.dialect`.
 * Quoting happens here and only here, so the argv above stays the values the
 * CLI actually receives.
 */
export function assembleLaunchCommand(
  input: AssembleLaunchCommandInput,
): LaunchCommand {
  const { program, args, stdinPrompt } = assembleLaunchArgv(input);
  const words: LaunchWord[] = [...(input.programArgs ?? []), ...args];
  return {
    command: shellCommandLine(program, words, input.dialect ?? "posix"),
    ...(stdinPrompt ? { stdinPrompt } : {}),
  };
}
