/**
 * 投递前看一眼终端画面：是不是停在 CLI 自己的对话框上（设计
 * `agent-delivery.md` §4.3「画面门」）。
 *
 * 纯函数，没有 I/O：画面由调用方经终端桥的 `capture` 取来（tmux 读真屏幕，
 * direct 后端读回放缓冲重放出来的屏幕，`terminal/replay-screen.ts`），这里只
 * 判。
 *
 * 为什么要有它：状态通道说的是「这一轮结束了 / 会话开场了」，不是「输入框在
 * 前台」。2026-10-02 实测（Claude Code 2.1.286，用户缺省权限为
 * `bypassPermissions`）：Claude 一起来就弹「Make auto mode your default
 * permission mode?」，缺省选项是「是」；Hook 照样报了开场，首投放行门把对端
 * `send` 的正文加回车打了进去——回车替人确认了那个对话框，改写了真实的
 * `~/.claude/settings.json`。
 *
 * 范围刻意收窄（§12 第 3 条的例外只开这么大）：
 *
 *   1. 只认**已知的**对话框。每家 CLI 一张特征表，特征是对话框里独有的标题
 *      或选项文字（取自 CLI 安装包里的字符串、本机实际画面或官方文档），不
 *      做通用的屏幕理解。唯一的通用判据是「选择菜单」（{@link MENU_CUES}）：
 *      高亮的编号选项或「回车确认 / Esc 取消」一类页脚出现在最后一处提示符
 *      之后，就当作一个没登记的对话框——宁可排队，也不让回车替人选了缺省项。
 *   2. 「画面上没有输入提示符」只在**首投**时才拦——会话起来 / 恢复之后、
 *      按首投放行门（`silentStartIdle` / `sessionStartIdle`）放行的那一次。
 *      那一次放行凭的是「会话够老」，不是任何一条说「输入框在前台」的事实，
 *      所以要求画面上看得见提示符。只有提示符特征核实过的 CLI 才做这一条，
 *      没核实过的提示符认不出来，拦了就是永远投不进去。
 *
 * 判据只看画面的最后 {@link SCREEN_GATE_LINES} 行，并且按位置判：对话框的特征
 * 出现在最后一处提示符**之后**才算「此刻停在对话框上」。direct 后端的
 * capture 带着滚出屏幕的历史，一个答过的对话框的字还留在上面；tmux 读的是
 * 真屏幕，没有这个问题，但同一条规矩对它也成立。
 */

/** 取画面的行数。与 `agent/routes.ts` 取标题时的 40 行同量级，多留一点给高的节点。 */
export const SCREEN_GATE_LINES = 60;

/**
 * 一条特征是怎么来的。`verified` 为真表示对过本机的实物——装好的那一版 CLI
 * 安装包里的字符串，或本机实际画面；为假表示只依据官方文档或同源 CLI 推断，
 * 装机后要回来核实（`source` 写明版本与出处）。
 */
export interface SignatureOrigin {
  readonly verified: boolean;
  readonly source: string;
}

export interface DialogSignature extends SignatureOrigin {
  /** 稳定的标识，进追溯与日志：`<cli>.<对话框>`。 */
  readonly id: string;
  /** 对话框里某一行独有的文字。逐行匹配。 */
  readonly pattern: RegExp;
  /**
   * 不受位置规则放行：这一行画在输入框**上面**（页脚在它下面），位置规则会把它当成
   * 「已答过的」，但它说的是一件**还在等人**的事（agy 的「有工件等审」）。命中就
   * 拦，不看提示符在不在它下面。
   */
  readonly sticky?: boolean;
}

export interface PromptSignature extends SignatureOrigin {
  /** 输入提示符所在的那一行（或紧贴它的页脚）的特征，逐行匹配。 */
  readonly pattern: RegExp;
}

/** 一家 CLI 登记的全部画面特征（含没核实的），见 {@link SCREEN_SIGNATURES}。 */
export interface ScreenSignatures {
  readonly dialogs: readonly DialogSignature[];
  readonly prompt?: PromptSignature;
}

/**
 * 判定实际用到的那一份，由 {@link screenProfile} 从特征表里取出。
 *
 * 对话框不论核实与否都用：认错一个对话框的代价是排队，认漏的代价是替人答题。
 * 提示符只用核实过的：要求看得见一个没核实过的提示符，认不出来就永远投不进
 * 去。
 */
export interface ScreenProfile {
  /** 进追溯的 CLI 名，通用菜单判据的 id 以它为前缀。 */
  readonly agent: string;
  readonly dialogs: readonly DialogSignature[];
  /** 缺席表示首投时不要求看得见提示符，只拦对话框。 */
  readonly prompt?: RegExp;
}

/**
 * 通用的「选择菜单」特征：不认是哪个对话框，只认「这里正等人选一项」。
 *
 *   * 高亮的编号选项：`❯ 1.`（Claude、Copilot）、`› 2.`（Codex）、`> 1.`。
 *   * 菜单页脚：`Enter to confirm · Esc to cancel`（Claude）、`enter continue ·
 *     esc skip`（Codex）、`Press Enter to continue.`（Codex 重建本地库）、
 *     `[y/N]` 一类的问句。
 *
 * 只在它们出现在最后一处提示符**之后**才算；答过的菜单留在历史里不算。
 */
export const MENU_CUES: readonly RegExp[] = [
  /^\s*[│|]?\s*[❯›>]\s*\d+\.\s+\S/,
  /\bEnter to confirm\b|\bEsc to cancel\b/i,
  /\benter (?:to )?continue\b.*\besc\b/i,
  /\bPress Enter to continue\b/i,
  /\[(?:y\/N|Y\/n|y\/n)\]\s*:?\s*$/,
];

/**
 * 各家的画面特征。键是注册表里的基础 Agent id（自定义 Agent 按 base 查）。
 * 界面改版时从这里改；每条都写明出处与版本。
 */
export const SCREEN_SIGNATURES: Readonly<Record<string, ScreenSignatures>> = {
  claude: {
    dialogs: [
      {
        id: "claude.workspace-trust",
        pattern:
          /Is this a project you created or one you trust\?|Yes, I trust this folder/i,
        verified: true,
        source: "Claude Code 2.1.286 安装包字符串",
      },
      {
        id: "claude.bypass-permissions-warning",
        pattern: /Claude Code running in Bypass Permissions mode/i,
        verified: true,
        source: "Claude Code 2.1.286 安装包字符串",
      },
      {
        id: "claude.auto-mode-default",
        pattern:
          /Make auto mode your default permission mode\?|Yes, set auto mode as my default permission mode/i,
        verified: true,
        source: "Claude Code 2.1.286 安装包字符串与本机画面（2026-10-02）",
      },
    ],
    prompt: {
      // 输入框里只有一个 `❯`，页脚是 `? for shortcuts` 或权限模式那一行。对话
      // 框的选项也用 `❯` 标当前项，但后面跟着编号，所以只认「单独一个 `❯`」。
      pattern:
        /^\s*[│|]?\s*[❯>]\s*[│|]?\s*$|\? for shortcuts|\(shift\+tab to cycle\)/,
      verified: true,
      source: "Claude Code 2.1.286 本机画面",
    },
  },
  codex: {
    dialogs: [
      {
        id: "codex.folder-trust",
        pattern:
          /Trust this folder\?|\bTrust and continue\b|Your trust decision will be saved/,
        verified: true,
        source: "Codex 0.159.3 本机画面；0.160.0 安装包字符串",
      },
      {
        // 两种形态：模态的「Update available! A -> B」加三个选项（`Update now
        // (runs …)` / `Skip` / `Skip until next version`），与 0.160.0 的
        // 「✨ Update available!」加 `See full release notes`。后者不认安装方式
        // 时只是历史里的一条横幅，下面就是输入框——位置规则让它放行。
        id: "codex.update",
        pattern:
          /Update available\b|Update now \(runs|Skip until next version|See full release notes/,
        verified: true,
        source: "Codex 0.155.1 本机画面；0.160.0 安装包字符串",
      },
      {
        // 回车 = 「Trust all and continue」，会把信任写进用户的 config.toml。
        id: "codex.hooks-review",
        pattern:
          /Hooks need review|Trust all and continue|Continue without trusting \(hooks won't run\)/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串（startup_hooks_review）",
      },
      {
        // 回车 = 「Try new model」，改写用户的模型配置。
        id: "codex.model-migration",
        pattern:
          /Codex just got an upgrade\. Introducing|\bTry new model\b|\bUse existing model\b/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串（model_migration）",
      },
      {
        id: "codex.sign-in",
        pattern:
          /Choose how you want to use Codex|Sign in with ChatGPT to use Codex as part of your paid plan|Provide your own API key/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串（onboarding）",
      },
      {
        id: "codex.rate-limit-switch",
        pattern:
          /Switch to .+ for lower credit usage\?|Keep current model \(never show again\)/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
      {
        id: "codex.full-access-warning",
        pattern: /Yes, continue anyway|Apply full access for this session/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
      {
        id: "codex.mcp-install",
        pattern: /Install MCP servers\?/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
      {
        id: "codex.database-rebuilt",
        pattern:
          /Codex rebuilt its local database|Codex detected a damaged local database/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
    ],
    prompt: {
      // `›` 加占位文字（`Ask Codex to do anything` / `Ask a follow-up
      // question`）。对话框的选项也用 `›`，后面跟编号；启动或接回还没完成时
      // 输入框里是 `Waiting for startup` / `Resuming session…`，那时打进去的
      // 字只会被排进 Codex 自己的队，不算就绪。
      pattern:
        /^\s*›(?!\s*\d+\.)(?!\s*(?:Waiting for startup|Resuming session|Forking session))/,
      verified: true,
      source: "Codex 0.159.3 本机画面；0.160.0 安装包字符串",
    },
  },
  copilot: {
    dialogs: [
      {
        // 选项 2 会把目录记进用户配置。
        id: "copilot.folder-trust",
        pattern:
          /Confirm folder trust|Do you trust the files in this folder\?|Yes, and remember this folder for future sessions|Copilot may attempt to read, modify, and execute files/i,
        verified: false,
        source:
          "GitHub 官方文档《Using GitHub Copilot CLI》（2026-10 查阅），本机未安装",
      },
    ],
  },
  // Antigravity：只有 `--unverified`（没有状态通道）时才用得到这道门。提示符取输入框
  // 下面那一行页脚：空闲时左侧是 `? for shortcuts`，右侧是 `auto · <模型> · <强度>`
  // （Default 模式只有一个 `·`）。生成时与审批卡开着时左侧都换成 `esc to cancel`
  // （1.5.16 真画面；1.5.17 二进制里 derivePhase / deriveHints / RenderBuiltIn 一致：
  // 待确认列表非空时阶段是 ToolConfirmation，强制显示 EscToCancel，不画
  // `? for shortcuts`）。agy 不发 OSC 133，所以只能靠页脚。答过的审批卡留在历史里
  // （页脚在它下面）按位置规则放行。
  agy: {
    prompt: {
      pattern: /^\s*\? for shortcuts\s+\S.*·/,
      verified: true,
      source:
        "Antigravity CLI 1.5.16 本机真画面的空闲页脚与开卡画面（tmux / PTY，2026-11-24；开卡时左侧是 `esc to cancel`）；1.5.17 二进制一致",
    },
    dialogs: [
      {
        // 「Yes」会把目录记进用户的信任列表。
        id: "agy.folder-trust",
        pattern:
          /Yes, I trust this folder|Do you trust the contents of this project\?/,
        verified: true,
        source: "Antigravity CLI 1.5.16 本机真画面（tmux / PTY，2026-11-24）",
      },
      {
        // 审批卡的选项行；卡出现时输入框被它顶掉，页脚左侧是 `esc to cancel`。
        id: "agy.approval",
        pattern:
          /Yes, allow creation|No, deny creation|Yes, and always allow|No, and always deny|Yes, grant permission for/,
        verified: true,
        source:
          "Antigravity CLI 1.5.16 本机真画面的开卡（2026-11-24，选项 `Yes, allow creation` / `Yes, and always allow non-workspace access` / `No, deny creation`）；1.5.17 二进制一致",
      },
      {
        // 回合已经结束、有工件等着人审（计划模式的实施计划就是一个）：阶段是
        // ReviewAvailable，页脚可以画 `? for shortcuts`，所以输入框看上去是空闲的。
        // 待审提示 `N artifact(s) · /artifact to review` 画在页脚上方，位置规则会把它
        // 判成已答过，所以标 `sticky`。真正的拦截靠 OSC 7501 的 `blocked` 否决门
        // （agy 在这个阶段报 blocked / permission / "Approve plan"，契约 §120），这一条
        // 只是再兜一层。
        id: "agy.artifact-pending",
        pattern: /\d+ artifacts? · \/artifact to review/,
        verified: false,
        sticky: true,
        source:
          "Antigravity CLI 1.5.17 二进制反汇编（格式串 `%d %s · /artifact to review`），没有真画面",
      },
      {
        // 审阅面板（ctrl+r 或 `/artifact`）：全屏覆盖层，没有页脚。面板里 `y` 是批准、
        // `n` 是驳回、`shift+a` / `shift+r` 是全部批准 / 驳回，写进去的字会被当成按键。
        id: "agy.artifact-panel",
        pattern:
          /^\s*Action required(?: \(\d+ left\))?\s*$|[□✓✗] (?:new|approved|rejected)\b/,
        verified: false,
        source:
          "Antigravity CLI 1.5.17 二进制反汇编（ArtifactViewModel 的渲染：`Action required (%d left)`、`□ new` / `✓ approved` / `✗ rejected`），没有真画面",
      },
      {
        // 审阅面板的两个确认框：查看器关闭前 `You have %d unsent comment(s). Send to agent?`
        // （选项 `send + close` / `discard + close`），和改工件前
        // `Comments will be discarded if you modify the artifact. Open editor?`。
        id: "agy.artifact-comments",
        pattern:
          /You have \d+ unsent comment\(s\)\. Send to agent\?|Comments will be discarded if you modify the artifact\. Open editor\?/,
        verified: false,
        source:
          "Antigravity CLI 1.5.17 二进制反汇编（字面量 `You have %d unsent comment(s). Send to agent?` 与 `Comments will be discarded if you modify the artifact. Open editor?`），没有真画面",
      },
    ],
  },
  grok: {
    dialogs: [
      {
        // 目录里有项目指令 / `.grok` / `.claude`，或用户有自己的 hook 时，除家目录外
        // 每个目录都问；输入框里打字就是作答（`y` 进、`n` 直接退出），所以它是
        // 投递的硬前置。「Yes」会把决定记进用户的 `trusted_folders.toml`。
        id: "grok.folder-trust",
        pattern:
          /Do you trust the contents of this directory\?|Grok Build may run or modify contents in this directory/,
        verified: true,
        source: "Grok Build 1.0.92 本机画面（tmux / PTY，2026-11-24）",
      },
      {
        // 工具审批卡：选项行 `3 (●) Yes, proceed`（编号会跳号）与页脚
        // `1/5:select │ Tab:next option`。卡出现时输入框被它顶掉，Enter 或数字键
        // 就是在替人答题。
        id: "grok.approval",
        pattern:
          /^\s*[┃|]\s+\d\s+\([○●]\)\s+\S|\d\/\d:select\s+[│|]\s+Tab:next option/,
        verified: true,
        source: "Grok Build 1.0.92 本机画面（tmux，2026-11-24）",
      },
      {
        // plan 模式下 exit_plan_mode 之后的计划审阅：回合不结束，画面出现动作栏
        // `a approve | s request changes | c comment | y copy plan | q quit plan`
        // （预览有焦点时是 `a:approve │ q:quit plan` 的写法；按 Tab 把焦点切到输入框后，动作栏在提示符上方、页脚变成 `Tab:plan │ Esc:back`，只剩输入框下边框的 `· plan approval` 还在提示符之后），焦点在预览时按单个
        // 字母就会执行对应动作——往里投正文等于替人点「批准」或「退出」。
        id: "grok.plan-review",
        pattern:
          /a approve\s+\|\s+s request changes|a:approve\s+│\s+q:quit plan|·\s+plan approval\s+─*╯/,
        verified: true,
        source: "Grok Build 1.0.92 本机画面（审查实测，2026-11-25）",
      },
    ],
    prompt: {
      // 输入框 `│ ❯ … │`（空的，或带灰色的建议文字）。滚动区里用户消息的回显
      // `❯ go  5:34 PM` 没有左边框，不是提示符。
      pattern: /^\s*│\s*❯(?:\s|$)/,
      verified: true,
      source: "Grok Build 1.0.92 本机画面（tmux，2026-11-24）",
    },
  },
  pi: {
    dialogs: [
      {
        // 目录里有 `.pi` 配置或 `.agents/skills` 且缺省信任为 `ask` 时启动就问；
        // 缺省选项「Trust」会把决定存进用户的信任文件。
        id: "pi.project-trust",
        pattern:
          /Trust project folder\?|Trust \(this session only\)|Do not trust \(this session only\)/,
        verified: true,
        source: "Pi 1.0.0 安装包字符串（resolveProjectTrusted）",
      },
    ],
  },
  omp: {
    dialogs: [
      {
        id: "omp.project-trust",
        pattern:
          /Trust project folder\?|Trust \(this session only\)|Do not trust \(this session only\)/,
        verified: false,
        source:
          "按同源的 Pi 1.0.0 推断；OMP 官方文档只提到 `omp setup`，本机未安装",
      },
    ],
  },
  // OpenCode：官方文档（opencode.ai/docs/tui，2026-10 查阅）没有启动对话框，提
  // 供方在 `/connect` 里手动加；提示符没核实。整条门不跑。
  opencode: { dialogs: [] },
};

/**
 * 这家 CLI 判定要用的画面特征；没有就整条门不跑，连 capture 都不取。
 *
 * 没有对话框、也没有核实过的提示符的 CLI 答 `undefined`。
 */
export function screenProfile(baseAgentId: string): ScreenProfile | undefined {
  const signatures = Object.hasOwn(SCREEN_SIGNATURES, baseAgentId)
    ? SCREEN_SIGNATURES[baseAgentId]
    : undefined;
  if (signatures === undefined) return undefined;
  const prompt =
    signatures.prompt?.verified === true
      ? signatures.prompt.pattern
      : undefined;
  if (signatures.dialogs.length === 0 && prompt === undefined) return undefined;
  return { agent: baseAgentId, dialogs: signatures.dialogs, prompt };
}

/** 通用菜单判据给出的对话框 id。 */
export function unrecognizedMenuId(agent: string): string {
  return `${agent}.unrecognized-menu`;
}

export type ScreenVerdict =
  | { readonly kind: "clear" }
  /** 停在一个已知对话框或一个认不出来的选择菜单上。 */
  | { readonly kind: "dialog"; readonly dialog: string }
  /** 首投时画面上看不见输入提示符。 */
  | { readonly kind: "no-prompt" };

/**
 * 判一块画面。`first` 是「这一次是不是首投」（见文件头第 2 条）。
 *
 * 画面取不到时调用方传 `undefined`：首投且这家有提示符特征就当作「看不见提
 * 示符」（宁可排队），否则放过——取画面失败不该让一条平常的投递从此投不进去。
 *
 * 一行既像提示符又像对话框（Codex 的选项 `› Trust all and continue` 没有编号
 * 时就是这样），按对话框算：错拦只是排队，错放是替人答题。
 */
export function judgeScreen(
  profile: ScreenProfile,
  screen: string | undefined,
  first: boolean,
): ScreenVerdict {
  if (screen === undefined) {
    return first && profile.prompt !== undefined
      ? { kind: "no-prompt" }
      : { kind: "clear" };
  }
  const lines = screen.split("\n").slice(-SCREEN_GATE_LINES);
  let lastPrompt = -1;
  let lastDialog = -1;
  let dialog = "";
  let sticky = "";
  for (const [index, line] of lines.entries()) {
    const hit = profile.dialogs.find((entry) => entry.pattern.test(line));
    if (hit !== undefined) {
      lastDialog = index;
      dialog = hit.id;
      if (hit.sticky === true) sticky = hit.id;
      continue;
    }
    if (MENU_CUES.some((cue) => cue.test(line))) {
      // 已知对话框的标题在上、它的选项与页脚在下：沿用那个已知的 id。
      if (lastDialog < 0 || lastPrompt > lastDialog) {
        dialog = unrecognizedMenuId(profile.agent);
      }
      lastDialog = index;
      continue;
    }
    if (profile.prompt?.test(line) === true) lastPrompt = index;
  }
  if (lastDialog >= 0 && lastDialog > lastPrompt) {
    return { kind: "dialog", dialog };
  }
  // 「还在等人」的那类提示画在输入框上面，位置规则放不了它。
  if (sticky !== "") return { kind: "dialog", dialog: sticky };
  if (first && profile.prompt !== undefined && lastPrompt < 0) {
    return { kind: "no-prompt" };
  }
  return { kind: "clear" };
}
