import { workflowDomain } from "../../workflow/registry";
import { recordVerdict, runById, verifyingStepsOf } from "../../workflow/store";
import { DomainError } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { type Args, Refusal, Refused } from "../refusals";
import type { CollabContext } from "../service";
import { type Outcome, result } from "./outcome";

/**
 * `workflow-propose`（协调 Agent §5.2，契约 §15.1）：把一次协作沉淀成一份
 * **草案**。协调者只出草案，存、改、确认是人的事：这里校验、写一行
 * `workflow_drafts`、推 `workflow.draft`，页面出一张草案卡。
 *
 * `--draft` 是草案 JSON：经 `armadra-hook` 的 JSON 调用时是一个对象，从命令行来
 * 时是一段 JSON 字符串，两种都收。
 */
export function workflowPropose(
  _context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const domain = workflowDomain();
  if (domain === undefined) {
    throw new Refused(503, "internal_error", "工作流域还没有装配好。");
  }
  const raw = args.value("draft");
  if (raw === undefined) {
    throw Refusal.badRequest("workflow-propose 需要 --draft <草案 JSON>。");
  }
  if (args.flag("dry-run")) {
    return result("（演练）草案会交给人确认。", { dryRun: true });
  }
  let row;
  try {
    row = domain.service.propose(
      {
        workspaceId: caller.node.workspaceId,
        boardId: caller.node.boardId,
        nodeId: caller.node.id,
      },
      raw,
    );
  } catch (error) {
    if (error instanceof DomainError) {
      throw new Refused(error.status, error.code, error.message);
    }
    throw error;
  }
  return result(
    `草案「${row.draft.title}」已经交上去了，画布上会出现一张草案卡，等人确认后存为模板。`,
    { draftId: row.id, status: row.status, title: row.draft.title },
  );
}

const MAX_ISSUES = 16;
const MAX_ISSUE_LENGTH = 500;

function badRequest(message: string): Refused {
  return new Refused(400, "bad_request", message);
}

/**
 * `workflow-verdict`（§2.6）：汇总角色按收件箱里的验证说明自己执行之后，用它报
 * 结论。只写 `verdict_json`（只留最近一次）：不推帧、不改步骤状态，判定在引擎
 * 的 `check` 里。
 */
export function workflowVerdict(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const pass = args.flag("pass");
  const raw = args.all("issue");
  if (pass === raw.length > 0) {
    throw badRequest(
      pass
        ? "--pass 与 --issue 不能同时给。"
        : "workflow-verdict 要么 --pass，要么至少一条 --issue '<角色 id>: <问题>'。",
    );
  }
  if (raw.length > MAX_ISSUES) {
    throw badRequest(`--issue 最多 ${MAX_ISSUES} 条。`);
  }
  for (const text of raw) {
    if ([...text].length > MAX_ISSUE_LENGTH) {
      throw badRequest(`每条 --issue 最多 ${MAX_ISSUE_LENGTH} 个字。`);
    }
  }

  const mine = verifyingStepsOf(context.database, caller.node.id)
    .map((entry) => ({ entry, run: runById(context.database, entry.runId) }))
    .filter(({ entry, run }) => {
      const step = run?.template.steps.find((s) => s.id === entry.stepId);
      return step?.kind === "collect" && step.verify != null;
    });
  const wanted = args.text("step");
  const picked =
    wanted === undefined
      ? mine
      : mine.filter(({ entry }) => entry.stepId === wanted);
  if (picked.length === 0) {
    throw new Refused(
      409,
      "no_verifying_step",
      "你不是任何一个正在验证的汇总步骤的角色节点。",
    );
  }
  if (picked.length > 1) {
    throw badRequest(
      `你同时在验证多个步骤，用 --step 指明：${picked
        .map(({ entry }) => entry.stepId)
        .join("、")}。`,
    );
  }
  const { entry, run } = picked[0]!;
  const roles = new Set((run?.template.roles ?? []).map((role) => role.id));

  const issues = raw.map((line) => {
    const colon = line.indexOf(":");
    const head = colon > 0 ? line.slice(0, colon).trim() : "";
    if (head === "" || !roles.has(head)) {
      return { role: null, text: line };
    }
    const text = line.slice(colon + 1).trim();
    if (text === "") throw badRequest(`角色 \`${head}\` 后面没有写问题。`);
    return { role: head, text };
  });

  if (args.flag("dry-run")) {
    return result("（演练）结论会记下。", { dryRun: true });
  }
  const at = (context.now?.() ?? new Date()).getTime();
  const written = recordVerdict(context.database, entry.runId, entry.stepId, {
    round: entry.round,
    pass,
    issues,
    at,
  });
  if (!written) {
    throw new Refused(
      409,
      "no_verifying_step",
      "这一步已经不在验证中，结论没有记下。",
    );
  }
  return result(
    pass ? "已记下：通过。" : `已记下：不通过，${issues.length} 条问题。`,
    { runId: entry.runId, stepId: entry.stepId, round: entry.round },
  );
}

/**
 * `workflow-run`（§2.9、契约 §122）：把调用方工作空间里一份项目级工作流文件交给
 * 画布引擎起跑。文件由 core 自己读，调用方只给 id 与参数；拒绝码同
 * `POST /api/workflows/runs`。
 */
export async function workflowRun(
  _context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const domain = workflowDomain();
  if (domain === undefined) {
    throw new Refused(503, "internal_error", "工作流域还没有装配好。");
  }
  const file = args.text("file");
  if (file === undefined) {
    throw badRequest("workflow-run 需要 --file <.ama/workflows 里的文件 id>。");
  }
  const params = args.value("params");
  let parsed: unknown;
  if (params !== undefined) {
    try {
      parsed = typeof params === "string" ? JSON.parse(params) : params;
    } catch {
      throw badRequest("--params 必须是 JSON 对象。");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw badRequest("--params 必须是 JSON 对象。");
    }
  }
  const hash = args.text("hash");
  const runId = args.text("run-id");
  let outcome;
  try {
    outcome = await domain.service.runFile(
      {
        workspaceId: caller.node.workspaceId,
        boardId: caller.node.boardId,
        nodeId: caller.node.id,
      },
      {
        file,
        hash,
        runId,
        params: parsed,
        dryRun: args.flag("dry-run"),
      },
    );
  } catch (error) {
    if (error instanceof DomainError) {
      throw new Refused(error.status, error.code, error.message);
    }
    throw error;
  }
  if (outcome.dryRun) {
    return result(`（演练）工作流「${outcome.title}」可以起跑，没有起。`, {
      dryRun: true,
    });
  }
  const { run, template, url } = outcome;
  return result(`工作流「${template.name}」已经起跑，在画布上看进度。`, {
    runId: run.id,
    templateId: template.id,
    templateVersion: run.templateVersion,
    status: run.status,
    url,
  });
}
