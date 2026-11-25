import { describe, expect, it } from "vitest";
import {
  SCREEN_GATE_LINES,
  SCREEN_SIGNATURES,
  judgeScreen,
  screenProfile,
  type ScreenProfile,
} from "./screen-gate";

/**
 * 画面门的判据（`agent-delivery.md` §4.3「画面门」）。
 *
 * 画面全是自编的文本：只保留每家对话框与提示符里那几行有辨识度的字，布局、
 * 路径与状态栏都是编的，不含任何真实会话内容。
 *
 * 例外是来自真机的：`AGY_TRUST`、`AGY_APPROVAL` 与 `AGY_IDLE_*` 是 Antigravity CLI
 * 1.5.16 的真画面（tmux / PTY，2026-11-24，已去掉邮箱与本机路径）；Grok 的两张
 * 是 Grok Build 1.0.92 的真画面。别的家的是按安装包字符串或官方文档编的。
 */

function profile(id: string): ScreenProfile {
  const found = screenProfile(id);
  if (found === undefined) throw new Error(`no profile for ${id}`);
  return found;
}

const CLAUDE_PROMPT = [
  " Claude Code vX.Y.Z",
  " ~/work/demo",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle)",
].join("\n");

const CLAUDE_PROMPT_DEFAULT_MODE = [
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const CLAUDE_AUTO_MODE_DIALOG = [
  " Claude Code vX.Y.Z",
  "╭──────────────────────────────────────╮",
  "│ Make auto mode your default permission mode?",
  "│ Auto mode lets Claude handle routine actions on its own.",
  "│ ❯ 1. Yes, set auto mode as my default permission mode",
  "│   2. No, keep bypass permissions",
  "╰──────────────────────────────────────╯",
  "  Enter to confirm · Esc to cancel",
].join("\n");

const CLAUDE_TRUST_DIALOG = [
  " Accessing workspace:",
  " /tmp/demo",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code)",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  " Enter to confirm · Esc to cancel",
].join("\n");

const CLAUDE_BYPASS_WARNING = [
  " WARNING: Claude Code running in Bypass Permissions mode",
  " By proceeding, you accept all responsibility.",
  " ❯ 1. No, exit",
  "   2. Yes, I accept",
].join("\n");

const CODEX_PROMPT = [
  ">_ Codex (vX.Y.Z)",
  "",
  "› Ask Codex to do anything",
  "",
  "  ? for shortcuts                         100% context left",
].join("\n");

const CODEX_UPDATE = [
  "  Update available · X.Y.Z → X.Y.W",
  "  Release notes: https://example.invalid/releases",
  "› 1. Update now (runs `npm install -g example`)",
  "  2. Skip",
  "  3. Skip until next version",
  "  enter continue · esc skip",
].join("\n");

const CODEX_TRUST = [
  "  Folder access",
  "  /tmp/demo",
  "  Trust this folder? Codex can read, edit, and run files here.",
  "› 1. Trust and continue",
  "  2. Back",
  "  enter continue · esc back",
].join("\n");

/** Grok Build 1.0.92 的真画面（tmux 取屏，只留辨识度高的几行，路径与内容是编的）。 */
const GROK_PROMPT = [
  "     ❯ go                                                           5:34 PM",
  "     probe done                                                     5:34 PM",
  "  ╭────────────────────────────────────────────────────────────────────╮",
  "  │ ❯ probe done                                                       │",
  "  ╰───────────────────────────────────────────────────────────── Mock ─╯",
  "  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

const GROK_EMPTY_PROMPT = [
  "  ╭────────────────────────────────────────────────────────────────────╮",
  "  │ ❯                                                                  │",
  "  ╰───────────────────────────────────────────────────────────── Mock ─╯",
].join("\n");

const GROK_APPROVAL = [
  "     ❯ go                                                           5:34 PM",
  "     ◆ Running probe",
  "  ┃",
  "  ┃  ›  probe",
  '  ┃  │ sh -c "echo x > probe.txt"',
  "  ┃  e edit pattern",
  "  ┃",
  '  ┃  1 (○) Always allow: sh -c "echo x > probe.txt"',
  "  ┃  3 (●) Yes, proceed",
  "  ┃  4 (○) No, reject (type to add feedback)",
  "  ┃  5 (○) Never allow: sh -c",
  "  ┃    (○) Yes, and don't ask again for anything (always-approve mode)",
  "  ┃",
  "  1/5:select  │  Tab:next option  │  e:edit pattern  │  Ctrl+c:cancel",
].join("\n");

const GROK_TRUST = [
  "   main /U/y/P/R/T/a/s/grok/proj2",
  "  Do you trust the contents of this directory?",
  "  /tmp/demo",
  "  Grok Build may run or modify contents in this directory,",
  "  posing security risks.",
  "  Yes, proceed  y",
  "  No, quit  n",
].join("\n");

// 1.5.16 真画面：未信任的目录里启动，没发提示。信任框下面残留的只有页脚的右半
// （`auto · 模型 · 强度`），左侧没有 `? for shortcuts`。
const AGY_TRUST = [
  "Accessing workspace:",
  "/tmp/demo",
  "Do you trust the contents of this project?",
  "Antigravity CLI requires permission to read, edit, and execute files here.",
  "> Yes, I trust this folder",
  "  No, exit",
  "  ↑/↓ Navigate · enter Confirm",
  "                                                              auto · Gemini 4 Neon · high",
].join("\n");

// 1.5.16 真画面：auto 模式下往工作区之外写文件弹出的审批卡。卡开着时页脚左侧是
// `esc to cancel`，不是 `? for shortcuts`。
const AGY_APPROVAL = [
  "      ▄▀▀▄        Antigravity CLI 1.5.16",
  "     ▀▀▀▀▀▀       Gemini 4 Neon (High)",
  "   ▄▀▀    ▀▀▄     /tmp/demo",
  "────────────────────────────────────────────────────────────",
  "> Create a file p2.txt containing hi, then run pwd",
  '○ Thought for 19.0s (Creating `/tmp/aa/p2.txt` with the content "hi".)',
  "● Edited 1 file (p2.txt)",
  "○ Running (pwd) (ctrl+o to expand)",
  "Create file",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "/private/tmp/aa/p2.txt  +1",
  "  1  +  hi",
  "Reason: outside workspace",
  "Allow creation of this file?",
  "> 1. Yes, allow creation",
  "  2. Yes, and always allow non-workspace access",
  "  3. No, deny creation",
  "  ↑/↓ Navigate · f full diff",
  "esc to cancel                                                                                auto · Gemini 4 Neon · high",
].join("\n");

// 1.5.16 真画面：空闲，Auto 模式与 Default 模式的页脚（Default 只有一个 `·`）。
const AGY_IDLE_AUTO = [
  "> Run the shell command: echo hi",
  "● Ran (echo hi) (ctrl+o to expand)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                                              auto · Gemini 4 Neon · high",
].join("\n");

const AGY_IDLE_DEFAULT = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                                                     Gemini 4 Neon · high",
].join("\n");

// 下面几张工件审阅的画面都是按 1.5.17 二进制的渲染函数编的，没有真画面：
// 回合已经结束、有工件等审（计划模式的实施计划）：阶段 ReviewAvailable，页脚是空闲的，
// 待审提示画在页脚上方。
const AGY_ARTIFACT_PENDING = [
  "● Wrote implementation_plan.md",
  "  1 artifact · /artifact to review",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                                              auto · Gemini 4 Neon · high",
].join("\n");

// 生成中轮播的小提示（28 条 tips 里的一条）：画法是 `└ Tip: …`，不是待审提示。
const AGY_TIP_WHILE_WORKING = [
  "⣽  Generating...",
  "└ Tip: Press ctrl+r to review pending artifacts.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "esc to cancel                                                                                auto · Gemini 4 Neon · high",
].join("\n");

// 审阅面板（全屏覆盖层，没有页脚）。
const AGY_ARTIFACT_PANEL = [
  "Artifacts",
  "Action required (2 left)",
  "□ new       implementation_plan.md",
  "✓ approved  task.md",
  "y approve · n reject · shift+a approve all · shift+r reject all",
  "Submit   Dismiss",
].join("\n");

const AGY_ARTIFACT_COMMENTS = [
  "You have 2 unsent comments. Send to agent?",
  "> send + close",
  "  discard + close",
].join("\n");

const COPILOT_TRUST = [
  " Confirm folder trust",
  " Do you trust the files in this folder?",
  " ❯ 1. Yes",
  "   2. No (Esc)",
].join("\n");

describe("judgeScreen", () => {
  it("Claude：提示符在前台，首投与平常都放行", () => {
    expect(judgeScreen(profile("claude"), CLAUDE_PROMPT, true)).toEqual({
      kind: "clear",
    });
    expect(
      judgeScreen(profile("claude"), CLAUDE_PROMPT_DEFAULT_MODE, true),
    ).toEqual({ kind: "clear" });
    expect(judgeScreen(profile("claude"), CLAUDE_PROMPT, false)).toEqual({
      kind: "clear",
    });
  });

  it("Claude：三个已知对话框，首投与平常都拦", () => {
    for (const [screen, dialog] of [
      [CLAUDE_AUTO_MODE_DIALOG, "claude.auto-mode-default"],
      [CLAUDE_TRUST_DIALOG, "claude.workspace-trust"],
      [CLAUDE_BYPASS_WARNING, "claude.bypass-permissions-warning"],
    ] as const) {
      for (const first of [true, false]) {
        expect(judgeScreen(profile("claude"), screen, first)).toEqual({
          kind: "dialog",
          dialog,
        });
      }
    }
  });

  it("对话框里的「❯ 1.」选项不算提示符，认不出标题也按菜单拦", () => {
    // 去掉标题行，只剩选项与页脚：认不出是哪个对话框，但这里正等人选一项。
    // 平常的投递也拦——回车会替人选了高亮的那一项。
    const options = [
      " ❯ 1. Something else",
      "   2. Another choice",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    for (const first of [true, false]) {
      expect(judgeScreen(profile("claude"), options, first)).toEqual({
        kind: "dialog",
        dialog: "claude.unrecognized-menu",
      });
    }
  });

  it("答过的对话框留在历史里、下面已经是提示符：放行", () => {
    const screen = `${CLAUDE_TRUST_DIALOG}\n\n${CLAUDE_PROMPT}`;
    expect(judgeScreen(profile("claude"), screen, true)).toEqual({
      kind: "clear",
    });
  });

  it("提示符之后又弹了对话框：拦", () => {
    const screen = `${CLAUDE_PROMPT}\n${CLAUDE_AUTO_MODE_DIALOG}`;
    expect(judgeScreen(profile("claude"), screen, false)).toMatchObject({
      kind: "dialog",
    });
  });

  it("只看最后几十行：滚出窗口的对话框不算", () => {
    const filler = Array.from(
      { length: SCREEN_GATE_LINES },
      (_, index) => `line ${index}`,
    ).join("\n");
    const screen = `${CLAUDE_AUTO_MODE_DIALOG}\n${filler}`;
    expect(judgeScreen(profile("claude"), screen, false)).toEqual({
      kind: "clear",
    });
  });

  it("首投时画面空白或还没画出提示符：拦", () => {
    expect(judgeScreen(profile("claude"), "", true)).toEqual({
      kind: "no-prompt",
    });
    expect(
      judgeScreen(profile("claude"), " Claude Code vX.Y.Z\n loading…", true),
    ).toEqual({ kind: "no-prompt" });
    expect(judgeScreen(profile("claude"), "", false)).toEqual({
      kind: "clear",
    });
  });

  it("画面取不到：首投当作看不见提示符，平常放过", () => {
    expect(judgeScreen(profile("claude"), undefined, true)).toEqual({
      kind: "no-prompt",
    });
    expect(judgeScreen(profile("claude"), undefined, false)).toEqual({
      kind: "clear",
    });
  });

  it("Codex：提示符、升级提示、目录信任", () => {
    expect(judgeScreen(profile("codex"), CODEX_PROMPT, true)).toEqual({
      kind: "clear",
    });
    expect(judgeScreen(profile("codex"), CODEX_UPDATE, true)).toEqual({
      kind: "dialog",
      dialog: "codex.update",
    });
    expect(judgeScreen(profile("codex"), CODEX_TRUST, false)).toEqual({
      kind: "dialog",
      dialog: "codex.folder-trust",
    });
  });

  it("Codex：「› 1.」是对话框的选项，不是提示符", () => {
    const options = "› 1. Something\n  2. Other";
    expect(judgeScreen(profile("codex"), options, true)).toEqual({
      kind: "dialog",
      dialog: "codex.unrecognized-menu",
    });
  });

  it("Copilot：只拦已知对话框，首投不要求提示符（提示符未核实）", () => {
    expect(judgeScreen(profile("copilot"), COPILOT_TRUST, true)).toEqual({
      kind: "dialog",
      dialog: "copilot.folder-trust",
    });
    expect(judgeScreen(profile("copilot"), "", true)).toEqual({
      kind: "clear",
    });
    expect(judgeScreen(profile("copilot"), undefined, true)).toEqual({
      kind: "clear",
    });
  });

  it("Grok：输入框（空的或带建议文字）是提示符，滚动区里的回显不是", () => {
    for (const screen of [GROK_PROMPT, GROK_EMPTY_PROMPT]) {
      expect(judgeScreen(profile("grok"), screen, true)).toEqual({
        kind: "clear",
      });
    }
    // 只有滚动区回显、没有输入框：首投看不见提示符。
    expect(
      judgeScreen(profile("grok"), "     ❯ go    5:34 PM\n  working…", true),
    ).toEqual({ kind: "no-prompt" });
  });

  it("Antigravity：真实的信任框与开着的审批卡都拦，卡的 id 是 agy.approval", () => {
    for (const first of [true, false]) {
      expect(judgeScreen(profile("agy"), AGY_TRUST, first)).toEqual({
        kind: "dialog",
        dialog: "agy.folder-trust",
      });
      expect(judgeScreen(profile("agy"), AGY_APPROVAL, first)).toEqual({
        kind: "dialog",
        dialog: "agy.approval",
      });
    }
  });

  it("Antigravity：页脚的右半（左侧没有提示）不算提示符，Default 模式与窄终端的页脚算", () => {
    const rightHalf = "                    auto · Gemini 4 Neon · high";
    expect(judgeScreen(profile("agy"), rightHalf, false)).toEqual({
      kind: "clear",
    });
    // 信任框下残留的右半页脚不能把框当成「提示符在它下面」而放行。
    expect(judgeScreen(profile("agy"), AGY_TRUST, false).kind).toBe("dialog");
    const prompt = profile("agy").prompt as RegExp;
    expect(prompt.test(AGY_IDLE_AUTO.split("\n").at(-1) as string)).toBe(true);
    expect(prompt.test(AGY_IDLE_DEFAULT.split("\n").at(-1) as string)).toBe(
      true,
    );
    // 窄终端：间距压到一个空格。
    expect(prompt.test("? for shortcuts auto · Gemini 4 Neon · high")).toBe(
      true,
    );
    // 开卡与生成时左侧是 `esc to cancel`。
    expect(prompt.test(AGY_APPROVAL.split("\n").at(-1) as string)).toBe(false);
  });

  it("Antigravity：答过的卡留在历史里（页脚在它下面）放行，卡在页脚下面拦", () => {
    expect(
      judgeScreen(profile("agy"), `${AGY_APPROVAL}\n${AGY_IDLE_AUTO}`, false),
    ).toEqual({ kind: "clear" });
    expect(
      judgeScreen(profile("agy"), `${AGY_IDLE_AUTO}\n${AGY_APPROVAL}`, false),
    ).toEqual({ kind: "dialog", dialog: "agy.approval" });
    expect(judgeScreen(profile("agy"), AGY_IDLE_DEFAULT, false)).toEqual({
      kind: "clear",
    });
  });

  it("Antigravity：待审提示画在空闲页脚上方，位置规则放不了它，所以 sticky 地拦", () => {
    for (const first of [true, false]) {
      expect(judgeScreen(profile("agy"), AGY_ARTIFACT_PENDING, first)).toEqual({
        kind: "dialog",
        dialog: "agy.artifact-pending",
      });
    }
    const entry = SCREEN_SIGNATURES.agy?.dialogs.find(
      (dialog) => dialog.id === "agy.artifact-pending",
    );
    expect(entry?.sticky).toBe(true);
    // 提示没有了（审完、画面刷新）：页脚照旧空闲，放行。
    const reviewed = AGY_ARTIFACT_PENDING.replace(
      "  1 artifact · /artifact to review\n",
      "",
    );
    expect(judgeScreen(profile("agy"), reviewed, false)).toEqual({
      kind: "clear",
    });
    // 复数。
    expect(
      judgeScreen(
        profile("agy"),
        AGY_ARTIFACT_PENDING.replace("1 artifact", "3 artifacts"),
        false,
      ),
    ).toEqual({ kind: "dialog", dialog: "agy.artifact-pending" });
  });

  it("Antigravity：生成中轮播的 `└ Tip: Press ctrl+r…` 不是待审提示，不按它拦", () => {
    const verdict = judgeScreen(profile("agy"), AGY_TIP_WHILE_WORKING, false);
    // 页脚 `esc to cancel` 会被通用的菜单特征当成没见过的菜单（目标本来在忙），
    // 但不是 agy 的任何一条工件审阅。
    expect(verdict.kind).toBe("dialog");
    expect(verdict.kind === "dialog" ? verdict.dialog : "").not.toMatch(
      /^agy\.artifact/,
    );
    expect(
      judgeScreen(
        profile("agy"),
        "└ Tip: Press ctrl+r to review pending artifacts.\n" + AGY_IDLE_AUTO,
        false,
      ),
    ).toEqual({ kind: "clear" });
  });

  it("Antigravity：审阅面板与它的确认框打开时拦", () => {
    expect(judgeScreen(profile("agy"), AGY_ARTIFACT_PANEL, false)).toEqual({
      kind: "dialog",
      dialog: "agy.artifact-panel",
    });
    expect(judgeScreen(profile("agy"), AGY_ARTIFACT_COMMENTS, false)).toEqual({
      kind: "dialog",
      dialog: "agy.artifact-comments",
    });
    expect(judgeScreen(profile("agy"), "Action required\n", false)).toEqual({
      kind: "dialog",
      dialog: "agy.artifact-panel",
    });
  });

  it("Antigravity：工件审阅的三条都只来自二进制推断，所以标 verified: false", () => {
    for (const id of [
      "agy.artifact-pending",
      "agy.artifact-panel",
      "agy.artifact-comments",
    ]) {
      const entry = SCREEN_SIGNATURES.agy?.dialogs.find(
        (dialog) => dialog.id === id,
      );
      expect(entry?.verified, id).toBe(false);
      expect(entry?.source, id).toContain("1.5.17");
    }
    expect(
      SCREEN_SIGNATURES.agy?.dialogs.some(
        (dialog) => dialog.id === "agy.artifact-review",
      ),
    ).toBe(false);
  });

  it("Grok：目录信任与审批卡都拦，首投与平常一样；答完卡、输入框回来就放行", () => {
    for (const first of [true, false]) {
      expect(judgeScreen(profile("grok"), GROK_TRUST, first)).toEqual({
        kind: "dialog",
        dialog: "grok.folder-trust",
      });
      expect(judgeScreen(profile("grok"), GROK_APPROVAL, first)).toEqual({
        kind: "dialog",
        dialog: "grok.approval",
      });
    }
    // 卡答过后留在历史里，输入框在它下面：位置规则放行。
    expect(
      judgeScreen(profile("grok"), `${GROK_APPROVAL}\n${GROK_PROMPT}`, true),
    ).toEqual({ kind: "clear" });
  });

  it("Grok：真实的审阅画面——预览有焦点、按 Tab 切到输入框之后——都拦", () => {
    for (const first of [true, false]) {
      for (const screen of [
        GROK_PLAN_REVIEW_REAL,
        GROK_PLAN_REVIEW_REAL_INPUT,
      ]) {
        expect(judgeScreen(profile("grok"), screen, first)).toEqual({
          kind: "dialog",
          dialog: "grok.plan-review",
        });
      }
    }
  });

  it("Grok：计划审阅（回合不结束，单个字母就是动作）拦，两种动作栏写法都认；回合结束后才打开的也一样", () => {
    for (const first of [true, false]) {
      expect(judgeScreen(profile("grok"), GROK_PLAN_REVIEW, first)).toEqual({
        kind: "dialog",
        dialog: "grok.plan-review",
      });
      expect(
        judgeScreen(profile("grok"), GROK_PLAN_REVIEW_FOCUSED, first),
      ).toEqual({ kind: "dialog", dialog: "grok.plan-review" });
      // 回合已经结束、输入框先在上面，审阅之后才在下面打开：审阅在后，仍拦。
      expect(
        judgeScreen(
          profile("grok"),
          `${GROK_PROMPT}\n${GROK_PLAN_REVIEW}`,
          first,
        ),
      ).toEqual({ kind: "dialog", dialog: "grok.plan-review" });
    }
  });

  it("没有对话框、也没有核实过的提示符的 CLI 没有画面特征", () => {
    for (const id of ["opencode", "unknown", "constructor", "toString"]) {
      expect(screenProfile(id)).toBeUndefined();
    }
  });
});

/** 真实画面（1.0.92，脚本化模型 + tmux 截取，2026-11-25）：审阅，预览有焦点。 */
const GROK_PLAN_REVIEW_REAL = `
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │──────────────────────────────────────────────────────────────────────────────────────────────────────────────────│
  │                  a approve  |  s request changes  |  c comment  |  y copy plan  |  q quit plan                   │
  ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
    ◆ No plan written: approve or request changes

  ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ ❯ Build anything                                                                                                 │
  ╰─────────────────────────────────────────────────────────────────────────────────────────── Mock · plan approval ─╯

  c:comment  │  y:copy plan  │  a:approve  │  q:quit plan  │  v:select  │  Tab:prompt
`;
/** 同一审阅按 Tab 切到输入框：动作栏在提示符上方，页脚是 Tab:plan。 */
const GROK_PLAN_REVIEW_REAL_INPUT = `
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │                                                                                                                  │
  │──────────────────────────────────────────────────────────────────────────────────────────────────────────────────│
  │                  a approve  |  s request changes  |  c comment  |  y copy plan  |  q quit plan                   │
  ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
    ◆ No plan written: approve or request changes

  ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                                                                │
  ╰─────────────────────────────────────────────────────────────────────────────────────────── Mock · plan approval ─╯

  Tab:plan  │  Esc:back
`;
const GROK_PLAN_REVIEW = [
  "  Plan",
  "  1. Add the thing",
  "  2. Test the thing",
  "  a approve | s request changes | c comment | y copy plan | q quit plan",
].join("\n");
const GROK_PLAN_REVIEW_FOCUSED = [
  "  Plan",
  "  1. Add the thing",
  "  a:approve  │  q:quit plan",
].join("\n");

/**
 * 每一条对话框特征一块自编画面：标题或选项里有辨识度的那一行取自特征的出处
 * （安装包字符串、本机画面或官方文档），其余是编的。不跑任何真 CLI。
 */
const DIALOG_SCREENS: Readonly<Record<string, string>> = {
  "agy.artifact-pending": AGY_ARTIFACT_PENDING,
  "agy.artifact-panel": AGY_ARTIFACT_PANEL,
  "agy.artifact-comments": AGY_ARTIFACT_COMMENTS,
  "agy.folder-trust": AGY_TRUST,
  "agy.approval": AGY_APPROVAL,
  "grok.folder-trust": GROK_TRUST,
  "grok.approval": GROK_APPROVAL,
  "grok.plan-review": GROK_PLAN_REVIEW,
  "claude.workspace-trust": CLAUDE_TRUST_DIALOG,
  "claude.bypass-permissions-warning": CLAUDE_BYPASS_WARNING,
  "claude.auto-mode-default": CLAUDE_AUTO_MODE_DIALOG,
  "codex.folder-trust": CODEX_TRUST,
  "codex.update": CODEX_UPDATE,
  "codex.hooks-review": [
    "  1 hook is new or changed.",
    "  Hooks need review",
    "  Hooks can run outside the sandbox after you trust them.",
    "  Review hooks",
    "  Trust all and continue",
    "  Continue without trusting (hooks won't run)",
  ].join("\n"),
  "codex.model-migration": [
    "  Codex just got an upgrade. Introducing model-b.",
    "  We recommend switching from model-a to model-b.",
    "  Try new model",
    "  Use existing model",
  ].join("\n"),
  "codex.sign-in": [
    "  Welcome to Codex, OpenAI's command-line coding agent",
    "  Sign in with ChatGPT to use Codex as part of your paid plan",
    "  or connect an API key for usage-based billing",
    "  Sign in with ChatGPT",
    "  Provide your own API key",
  ].join("\n"),
  "codex.rate-limit-switch": [
    "  Approaching rate limits",
    "  Switch to model-mini for lower credit usage?",
    "  Keep current model",
    "  Keep current model (never show again)",
  ].join("\n"),
  "codex.full-access-warning": [
    "  Codex can edit any file on your computer and run commands with network, without your approval.",
    "  Yes, continue anyway",
    "  Go back without enabling full access",
  ].join("\n"),
  "codex.mcp-install": [
    "  Install MCP servers?",
    "  Install and enable the missing MCP servers in your global config.",
  ].join("\n"),
  "codex.database-rebuilt": [
    "  Codex rebuilt its local database.",
    "  Continuing startup with a fresh local database...",
  ].join("\n"),
  "copilot.folder-trust": COPILOT_TRUST,
  "pi.project-trust": [
    " Trust project folder?",
    " /tmp/demo",
    " This allows pi to load .pi settings and resources.",
    " → Trust",
    "   Trust (this session only)",
    "   Do not trust",
  ].join("\n"),
  "omp.project-trust": [
    " Trust project folder?",
    " /tmp/demo",
    " → Trust",
    "   Do not trust (this session only)",
  ].join("\n"),
};

describe("特征表", () => {
  const entries = Object.entries(SCREEN_SIGNATURES).flatMap(([agent, table]) =>
    table.dialogs.map((dialog) => [agent, dialog.id] as const),
  );

  it.each(entries)("%s：%s 首投与平常都拦", (agent, id) => {
    const screen = DIALOG_SCREENS[id];
    expect(screen, `缺 ${id} 的自编画面`).toBeDefined();
    for (const first of [true, false]) {
      expect(judgeScreen(profile(agent), screen, first)).toEqual({
        kind: "dialog",
        dialog: id,
      });
    }
  });

  it("每条特征都写明了出处与核实与否，id 以 CLI 名开头、不重复", () => {
    const seen = new Set<string>();
    for (const [agent, table] of Object.entries(SCREEN_SIGNATURES)) {
      for (const entry of [
        ...table.dialogs,
        ...(table.prompt ? [table.prompt] : []),
      ]) {
        expect(typeof entry.verified).toBe("boolean");
        expect(entry.source.length).toBeGreaterThan(0);
      }
      for (const dialog of table.dialogs) {
        expect(dialog.id.startsWith(`${agent}.`)).toBe(true);
        expect(seen.has(dialog.id)).toBe(false);
        seen.add(dialog.id);
      }
    }
    // 自编画面与特征表一一对应：删了特征就删画面。
    expect([...seen].sort()).toEqual(Object.keys(DIALOG_SCREENS).sort());
  });

  it("没核实的提示符不进判定：首投不要求它", () => {
    for (const [agent, table] of Object.entries(SCREEN_SIGNATURES)) {
      const used = screenProfile(agent);
      if (table.prompt?.verified === true) {
        expect(used?.prompt).toBe(table.prompt.pattern);
      } else {
        expect(used?.prompt).toBeUndefined();
      }
    }
  });
});

describe("Codex 的变体", () => {
  it("升级提示的第二形态：0.160.0 的「✨ Update available!」", () => {
    const screen = [
      "  ✨ Update available! X.Y.Z -> X.Y.W",
      "  See full release notes:",
      "  https://example.invalid/releases/latest",
    ].join("\n");
    expect(judgeScreen(profile("codex"), screen, false)).toEqual({
      kind: "dialog",
      dialog: "codex.update",
    });
  });

  it("升级横幅留在历史里、下面是输入框：放行", () => {
    const screen = [
      "  ✨ Update available! X.Y.Z -> X.Y.W",
      "  See https://example.invalid for installation options.",
      CODEX_PROMPT,
    ].join("\n");
    expect(judgeScreen(profile("codex"), screen, true)).toEqual({
      kind: "clear",
    });
  });

  it("提示符的占位文字变体：追问也是提示符", () => {
    const screen = "› Ask a follow-up question\n\n  ? for shortcuts";
    expect(judgeScreen(profile("codex"), screen, true)).toEqual({
      kind: "clear",
    });
  });

  it("还在启动或接回：输入框里的占位不算提示符", () => {
    for (const placeholder of [
      "Waiting for startup",
      "Resuming session…",
      "Forking session…",
    ]) {
      expect(
        judgeScreen(profile("codex"), `>_ Codex\n\n› ${placeholder}`, true),
      ).toEqual({ kind: "no-prompt" });
    }
  });

  it("没有编号的选项与提示符同形：按对话框算", () => {
    const screen = [
      "  Hooks need review",
      "› Trust all and continue",
      "  Continue without trusting (hooks won't run)",
    ].join("\n");
    expect(judgeScreen(profile("codex"), screen, false)).toEqual({
      kind: "dialog",
      dialog: "codex.hooks-review",
    });
  });
});

describe("认不出来的选择菜单", () => {
  it("提示符之后出现编号选项或菜单页脚：拦", () => {
    for (const tail of [
      " ❯ 2. Something new",
      "  enter continue · esc skip",
      "  Press Enter to continue.",
      "  Continue anyway? [y/N]: ",
    ]) {
      const screen = `${CLAUDE_PROMPT}\n Some new dialog\n${tail}`;
      expect(judgeScreen(profile("claude"), screen, false)).toEqual({
        kind: "dialog",
        dialog: "claude.unrecognized-menu",
      });
    }
  });

  it("答过的菜单留在历史里、下面已经是提示符：放行", () => {
    const screen = ` Some old dialog\n ❯ 1. Yes\n   2. No\n${CLAUDE_PROMPT}`;
    expect(judgeScreen(profile("claude"), screen, false)).toEqual({
      kind: "clear",
    });
  });

  it("已知对话框下面的选项与页脚沿用它的 id", () => {
    expect(
      judgeScreen(profile("claude"), CLAUDE_AUTO_MODE_DIALOG, false),
    ).toEqual({ kind: "dialog", dialog: "claude.auto-mode-default" });
  });

  it("只有对话框、没有核实提示符的 CLI 同样认菜单（Copilot）", () => {
    const screen = " Allow this tool?\n ❯ 1. Yes\n   2. No (Esc)";
    expect(judgeScreen(profile("copilot"), screen, false)).toEqual({
      kind: "dialog",
      dialog: "copilot.unrecognized-menu",
    });
  });
});
