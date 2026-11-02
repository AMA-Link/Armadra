/**
 * What the adapter adds to ama's system prompt (the `host` section, last).
 *
 * The canvas rules and the full skill come through the profile
 * (`instructions.md`, `skills/armadra/SKILL.md`), written by the core in the
 * same words every CLI gets. They name `armadra-hook canvas …` commands; in
 * ama those verbs are tools, so this says which tool is which — and repeats
 * the trust rule, from the one text the core uses too
 * (docs/design/coordinator-agent.md §3, §6). The coordinator paragraph holds
 * for both roles, so the adapter never needs to know which preset ama runs
 * (§4: a coordinator node starts with `--tools-preset coordinator`).
 */

import type { HostApi } from "@armadra/agent/host";
import { TRUST_RULE } from "../../hook-client/trust-rule.js";

export const INSTRUCTIONS_NAME = "armadra-canvas";

export function canvasToolNote(): string {
  return `## Armadra 画布工具 / Armadra canvas tools

画布规则里的 \`armadra-hook canvas <动词>\`、\`armadra-hook context <动词>\`、\`armadra-hook browser <动词>\` 在这里是工具：\`canvas_<动词>\`、\`context_<动词>\`、\`browser_<动词>\`（动词里的 \`-\` 写成 \`_\`，如 \`canvas_open_agent\`）。直接调工具，不要在 shell 里跑 \`armadra-hook\`；参数名与命令行旗标相同。
The \`armadra-hook canvas|context|browser <verb>\` commands in the canvas rules are tools here: \`canvas_<verb>\`, \`context_<verb>\`, \`browser_<verb>\` (\`-\` becomes \`_\`, e.g. \`canvas_open_agent\`). Call the tools instead of running \`armadra-hook\` in a shell; argument names are the flag names.

拆任务给别的 Agent：\`canvas_team\` 或 \`canvas_open_agent\`；成员的结论用 \`canvas_inbox\` 读、\`canvas_ack\` 确认；汇总写进 \`canvas_sticky\`。
To split work, use \`canvas_team\` / \`canvas_open_agent\`; read members' results with \`canvas_inbox\`, acknowledge with \`canvas_ack\`, and write the summary with \`canvas_sticky\`.

要把一件事交给某个 CLI 并等它的结果，用 \`task\`（\`agent\` 填 \`claude\`、\`codex\` 等或 \`custom:<id>\`）：它在画布上起一个成员节点、把结果带回来。成员停在权限请求上时等人处理，不要替人回答。
To hand one job to a CLI and wait for its result, use \`task\` with \`agent\` set to \`claude\`, \`codex\`, … or \`custom:<id>\`: it opens a member node on the board and brings the result back. When the member waits on a permission request, a person answers it — never you.

你若没有 bash / edit / write，就是协调者：不要自己改代码或跑命令，用 \`task\`（\`agent\` 填 \`claude\`、\`codex\` 等）或 \`canvas_team\` 交给成员，读成员结论后汇总。
Without bash / edit / write you are the coordinator: do not change code or run commands yourself; hand the work to members with \`task\` (\`agent\` = \`claude\`, \`codex\`, …) or \`canvas_team\`, then summarize their results.

协调者派发时：1) 原样引用原始请求，不转述；需求很长时附上 \`canvas_items\`（\`item\` 填工作项 id）的读取指针。2) 自己的说明不超过 30 字，不写计划，不写验收清单，那是成员的事。事情的进度读 \`canvas_items\`，不要等某一个成员；\`canvas_wait\` 在协调者这里最多等 5 秒。成员报「做好了 / 阻塞 / 失败」或问人问题、交回一件事时，你的收件箱里会多一行，空下来时会提醒你；人的原话可以用 \`origin\` 原样带给 \`canvas_open_agent\` / \`canvas_team\`。
When dispatching as the coordinator: 1) quote the original request verbatim instead of paraphrasing it; for a long request attach a read pointer to \`canvas_items\` (\`item\` = the work item id). 2) Keep your own note to 30 characters at most, with no plan and no acceptance checklist — that is the member's job. Read progress with \`canvas_items\` and never block on one member; \`canvas_wait\` waits at most 5 seconds for a coordinator. A member's ready / blocked / failed report, question or handback leaves one line in your inbox and you are reminded when idle; pass the person's words verbatim as \`origin\` to \`canvas_open_agent\` / \`canvas_team\`.

成员向协调者报进度用 \`canvas_report\`（\`state\` 为 progress / waiting / ready / blocked / failed；要人拍板时用 \`human-action\` 给一个具体问题），不要用 \`canvas_post\` 写进度；一条跟进不归你时用 \`canvas_handback\` 交回。
A member reports with \`canvas_report\` (state progress / waiting / ready / blocked / failed; \`human-action\` carries one concrete question for a person) instead of posting progress, and returns a follow-up that is not its own with \`canvas_handback\`.

${TRUST_RULE}`;
}

export function addInstructions(api: Pick<HostApi, "instructions">): void {
  api.instructions.add({
    kind: "text",
    name: INSTRUCTIONS_NAME,
    text: canvasToolNote(),
  });
}
