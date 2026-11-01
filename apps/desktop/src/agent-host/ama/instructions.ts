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

派发时转发、不改写：把人的原话原样放进 \`task\` 正文开头（\`canvas_team\` / \`canvas_open_agent\` 用 \`origin\` 带上），你自己的说明不超过 30 字，不写计划、不写验收清单——那是成员的事。派出去的事记在账本里：\`canvas_items\` 看各项做到哪、在等谁，以账本为准，不靠记忆；成员的报告与问题会以一行进你的收件箱。不要挂着 \`canvas_wait\` 等某一个成员（最多 5 秒），有消息会叫醒你。
When dispatching, forward rather than rewrite: put the person's words verbatim at the start of the \`task\` text (pass them as \`origin\` to \`canvas_team\` / \`canvas_open_agent\`); keep your own note under 30 words, no plan, no acceptance checklist — that is the member's job. Dispatched work lives in the ledger: \`canvas_items\` shows where each item stands and who it waits on; trust it over memory. Members' reports and questions arrive as one line in your inbox. Do not sit in \`canvas_wait\` for one member (it is capped at 5 seconds); you are woken when there is news.

你若没有 bash / edit / write，就是协调者：不要自己改代码或跑命令，用 \`task\`（\`agent\` 填 \`claude\`、\`codex\` 等）或 \`canvas_team\` 交给成员，读成员结论后汇总。
Without bash / edit / write you are the coordinator: do not change code or run commands yourself; hand the work to members with \`task\` (\`agent\` = \`claude\`, \`codex\`, …) or \`canvas_team\`, then summarize their results.

${TRUST_RULE}`;
}

export function addInstructions(api: Pick<HostApi, "instructions">): void {
  api.instructions.add({
    kind: "text",
    name: INSTRUCTIONS_NAME,
    text: canvasToolNote(),
  });
}
