import type {
  CollectStep,
  PromptStep,
  WorkflowDraft,
  WorkflowVerify,
} from "./types";

/**
 * 共享约定、验证说明与正文末尾那一句的文本（契约 §15.7）。纯函数。
 *
 * 这些是投给 Agent 的提示词，不是界面文案，不进 i18n。约定与验证说明放进角色
 * 节点的收件箱；投递正文只追加 `stepSuffix` 的一句固定短语，所以代入后的提示词
 * 只需给它留 {@link STEP_NOTE_RESERVE} 字（`draft.ts::checkRendered`）。
 */

/** 正文末尾固定短语的字数上限，也是长度规则里给它留的余量。 */
export const STEP_NOTE_RESERVE = 200;

/** 收件箱里一条消息的字数上限（就是 `send` 正文的上限）。 */
const MESSAGE_LIMIT = 2_000;

const chars = (value: string): string[] => [...value];

/** 按码点截断到 `limit`；超出时末尾放 `…`。 */
function clip(value: string, limit: number): string {
  const all = chars(value);
  return all.length <= limit ? value : `${all.slice(0, limit - 1).join("")}…`;
}

/**
 * 逐条放进去，放不下的丢掉并注明条数。`head` 与 `tail` 固定保留。
 */
function fit(
  head: string,
  lines: readonly string[],
  tail: string,
  limit = MESSAGE_LIMIT,
): string {
  const fixed = chars(head).length + chars(tail).length;
  let used = fixed;
  const kept: string[] = [];
  for (const line of lines) {
    // 预留一行「另有 n 条未列出」的位置。
    const cost = chars(line).length + 1;
    if (used + cost > limit - 24) break;
    kept.push(line);
    used += cost;
  }
  const dropped = lines.length - kept.length;
  const body = [
    ...kept,
    ...(dropped > 0 ? [`另有 ${dropped} 条未列出。`] : []),
  ];
  return clip(
    [head, ...body, ...(tail === "" ? [] : [tail])].join("\n"),
    limit,
  );
}

function hasContract(draft: WorkflowDraft, roleId: string): boolean {
  return (
    (draft.contract?.text ?? "") !== "" ||
    (draft.contract?.owns?.[roleId]?.length ?? 0) > 0
  );
}

/** 把正文按空行切成段，每段不超过 `limit`（超长的段按字数硬切）。 */
function paragraphs(value: string, limit: number): string[] {
  const out: string[] = [];
  for (const raw of value.split(/\n\s*\n/)) {
    const part = raw.trim();
    if (part === "") continue;
    const all = chars(part);
    for (let start = 0; start < all.length; start += limit) {
      out.push(all.slice(start, start + limit).join(""));
    }
  }
  return out;
}

/**
 * 某个角色节点第一次投递前要放进收件箱的约定，每段一条（≤ 2000 字）。
 * 第一段是路径归属（glob 原样），其余是 `contract.text` 按段落切开。没有约定时为空。
 */
export function contractMessages(
  draft: WorkflowDraft,
  roleId: string,
): string[] {
  const contract = draft.contract;
  if (contract === undefined || contract === null) return [];
  const messages: string[] = [];
  const owns = contract.owns ?? {};
  const mine = owns[roleId] ?? [];
  const others = Object.entries(owns).filter(
    ([id, globs]) => id !== roleId && globs.length > 0,
  );
  if (mine.length > 0 || others.length > 0) {
    const otherLines = [
      ...(others.length === 0 ? [] : ["其他角色负责的路径，不要改："]),
      ...others.flatMap(([id, globs]) => [
        `${id}：`,
        ...globs.map((glob) => `- ${glob}`),
      ]),
    ];
    if (mine.length === 0) {
      messages.push(fit("你负责的路径：（未指定）", otherLines, ""));
    } else {
      // 本角色负责的路径全量保留：放不下就拆成多条；只有「其他角色」那部分允许被截。
      const budget = MESSAGE_LIMIT - 30;
      const chunks: string[][] = [[]];
      let used = chars("你负责的路径（续）：").length;
      for (const glob of mine) {
        const line = `- ${glob}`;
        const cost = chars(line).length + 1;
        if (used + cost > budget && chunks[chunks.length - 1]!.length > 0) {
          chunks.push([]);
          used = chars("你负责的路径（续）：").length;
        }
        chunks[chunks.length - 1]!.push(line);
        used += cost;
      }
      chunks.forEach((chunk, index) => {
        const head = index === 0 ? "你负责的路径：" : "你负责的路径（续）：";
        const last = index === chunks.length - 1;
        messages.push(
          last
            ? fit(head, [...chunk, ...otherLines], "")
            : [head, ...chunk].join("\n"),
        );
      });
    }
  }
  messages.push(...paragraphs(contract.text ?? "", MESSAGE_LIMIT));
  return messages;
}

/**
 * `collect` 每一轮开始时放进收件箱的验证说明；没有 `verify` 时返回 `undefined`。
 * ≤ 2000 字：放不下的清单项丢掉并注明条数。
 */
export function verifyMessage(
  draft: WorkflowDraft,
  step: CollectStep,
  round: number,
): string | undefined {
  const verify: WorkflowVerify | null | undefined = step.verify;
  if (verify === undefined || verify === null) return undefined;
  const roleOf = new Map(
    draft.steps.flatMap((entry) =>
      entry.kind === "gate" ? [] : [[entry.id, entry.role] as const],
    ),
  );
  const roles = [
    ...new Set(
      step.from.map((id) => roleOf.get(id)).filter((id) => id !== undefined),
    ),
  ];
  const commands = verify.commands ?? [];
  const checklist = verify.checklist ?? [];
  const lines = [
    ...(commands.length === 0
      ? []
      : ["先自己执行下列命令：", ...commands.map((command) => `$ ${command}`)]),
    ...(checklist.length === 0
      ? []
      : ["再逐条核对：", ...checklist.map((item) => `- ${item}`)]),
  ];
  const head = `验证（步骤 ${step.id}，第 ${round + 1} 轮）。来源步骤的角色：${roles.join("、")}。`;
  const tail =
    "全部通过用 canvas_workflow_verdict --pass；不通过每个问题一条 --issue '<角色 id>: 问题'。";
  return fit(head, lines, tail);
}

/**
 * 投递正文末尾那一句固定短语（≤ 200 字）。不含任何 id 或列表：来源步骤的结论、
 * 共享约定与验证说明都在收件箱里。没有要说的就是空串。
 */
export function stepSuffix(
  draft: WorkflowDraft,
  step: PromptStep | CollectStep,
): string {
  const parts: string[] = [];
  if (step.kind === "collect") parts.push("来源步骤的结论");
  if (hasContract(draft, step.role)) parts.push("共享约定");
  const verifies = step.kind === "collect" && step.verify != null;
  if (verifies) parts.push("验证说明");
  if (parts.length === 0) return "";
  const where = `（${parts.join("、")}在你的收件箱：canvas inbox。`;
  return verifies
    ? `${where}验证完用 canvas_workflow_verdict 报结论。）`
    : `${where}）`;
}

/** 验证不通过、退回角色时投给它的正文（≤ 2000 字，放不下的问题注明条数）。 */
export function feedbackBody(input: {
  readonly collectStepId: string;
  readonly round: number;
  readonly issues: readonly string[];
  readonly hasContract: boolean;
}): string {
  const head = `步骤 ${input.collectStepId} 第 ${input.round + 1} 轮验证没有通过，请按下面的问题修改后重新交付：`;
  const tail = input.hasContract
    ? "共享约定仍在你的收件箱：canvas inbox。"
    : "";
  return fit(
    head,
    input.issues.map((issue) => `- ${issue}`),
    tail,
  );
}
