import { statSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

import { canResume } from "../../agent/launch";
import { baseAgent } from "../../agent/registry";
import { getAgentStatus } from "../../agent/status";
import { executeOn } from "../../remote/execute";
import { canonicalize, contains } from "../../workspaces/roots";
import { DomainError } from "../../workspaces/support";
import { type Workspace, getWorkspace } from "../../workspaces/table";
import { type Caller, loadNode } from "../nodes";
import { Refusal, Refused } from "../refusals";
import type { CollabContext } from "../service";

/**
 * 协调者起成员时的两个选项（契约 §15.5）：成员开在哪（`--cwd`）、接回哪段会话
 * （`--resume`），`open-agent` 与 `team` 共用。另有远端工作区成员的 `ssh`：工作
 * 区在执行主机上时，成员也起在那台主机上（G5-07）。
 */

/** 远端工作区里成员节点要带的 `ssh`；本机工作区答 `undefined`。 */
export function memberSsh(
  context: CollabContext,
  caller: Caller,
): { readonly hostId: string } | undefined {
  const hostId = getWorkspace(
    context.database,
    caller.node.workspaceId,
  ).executionHostId;
  return hostId === undefined || hostId === "" ? undefined : { hostId };
}

/** `--cwd` 的形状：去掉首尾空白，空、超长或带控制字符的当场拒绝。 */
export function checkCwdText(raw: string, flag = "--cwd"): string {
  const value = raw.trim();
  if (
    value === "" ||
    value.length > 4_000 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw Refusal.badRequest(
      `${flag} 是工作区内的目录：相对工作区根，或绝对路径。`,
    );
  }
  return value;
}

/**
 * `--cwd`：成员终端开在哪（契约 §15.5）。工作区根下的相对路径，或落在工作区
 * 里的绝对路径；解开符号链接后再判是否在工作区里——链接指到工作区外面同样算
 * 越界。目录必须已经存在。
 *
 * 本机工作区按 core 这台机器的路径规则判；远端工作区交给执行主机上的 Worker
 * （`files.list`，与文件面同一条根约束），答那台主机上的绝对路径。Worker 不可达
 * 答 `cwd_unsupported`，ama 的 runner 据此去掉 `--cwd` 再起一次。
 */
export async function resolveCwd(
  context: CollabContext,
  caller: Caller,
  value: string,
  flag = "--cwd",
): Promise<string> {
  const workspace = getWorkspace(context.database, caller.node.workspaceId);
  if (workspace.executionHostId !== undefined) {
    return await remoteCwd(workspace, value, flag);
  }
  let root: string;
  try {
    root = canonicalize(workspace.rootPath);
  } catch {
    throw Refusal.badRequest("工作区根目录不存在。");
  }
  const outside = (): Refused =>
    new Refused(
      400,
      "cwd_outside_workspace",
      `${flag} \`${value}\` 不在这个工作区里。`,
    );
  const requested = isAbsolute(value) ? resolve(value) : resolve(root, value);
  let real: string;
  try {
    real = canonicalize(requested);
  } catch {
    // 不存在的路径：字面上就在工作区外的照样答越界，免得调用方以为建个目录
    // 就能过。
    if (
      !contains(root, requested) &&
      !contains(resolve(workspace.rootPath), requested)
    ) {
      throw outside();
    }
    throw Refusal.badRequest(`${flag} 的目录不存在：${value}`);
  }
  if (!contains(root, real)) throw outside();
  if (statSync(real, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw Refusal.badRequest(`${flag} 不是目录：${value}`);
  }
  return real;
}

/** 远端工作区：路径规则一律 POSIX（执行主机不是 POSIX 的，Worker 自己会拒）。 */
async function remoteCwd(
  workspace: Workspace,
  value: string,
  flag: string,
): Promise<string> {
  let listed: unknown;
  try {
    listed = await executeOn(workspace, "files.list", { path: value });
  } catch (failure) {
    if (!(failure instanceof DomainError)) throw failure;
    if (failure.status === 403) {
      throw new Refused(
        400,
        "cwd_outside_workspace",
        `${flag} \`${value}\` 不在这个工作区里。`,
      );
    }
    if (failure.status === 404) {
      throw Refusal.badRequest(`${flag} 的目录不存在：${value}`);
    }
    if (failure.status === 400) {
      throw Refusal.badRequest(`${flag} 不是工作区里的目录：${value}`);
    }
    throw new Refused(
      400,
      "cwd_unsupported",
      `执行主机上的工作区现在核实不了 ${flag}（${failure.message}），去掉它就开在工作区根。`,
    );
  }
  const relative = (listed as { path?: unknown } | null)?.path;
  if (typeof relative !== "string") {
    throw new Refused(400, "cwd_unsupported", "执行主机没有答出目录。");
  }
  return relative === "" || relative === "."
    ? workspace.rootPath
    : posix.join(workspace.rootPath, relative);
}

/** CLI 的会话 id：Claude / Codex 是 UUID，别家是带前缀的短串。 */
const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * `--resume`：接回这个 CLI 自己的一段会话（契约 §15.5），走 `agent/launch.ts`
 * 已有的 resume 行（Claude `--resume <id>`、Codex `resume <id>` …）。
 *
 * 这个 CLI 不能续接（或自定义条目关掉了 `resume`）答 `resume_unsupported`。
 * 给的是这块画布上一个成员节点的 id 时（runner 的 `sessionRef` 就是节点 id），
 * 取那个节点上报过的 CLI 会话 id；节点跑的不是同一家、或从没报过会话 id，同样
 * 答 `resume_unsupported`。
 */
export function resolveResume(
  context: CollabContext,
  caller: Caller,
  agentId: string,
  raw: string,
  flag = "--resume",
): string {
  const value = raw.trim();
  if (!RESUME_ID.test(value)) {
    throw Refusal.badRequest(
      `${flag} 是这个 CLI 的会话 id：1–200 个字母、数字或 . _ : - 。`,
    );
  }
  const unsupported = (message: string): Refused =>
    new Refused(400, "resume_unsupported", message);
  if (!canResume(context.settings, agentId)) {
    throw unsupported(`${agentId} 不能接回会话，去掉 ${flag} 新开一个。`);
  }
  const member = loadNode(context.database, value);
  if (
    member === undefined ||
    member.workspaceId !== caller.node.workspaceId ||
    member.boardId !== caller.node.boardId
  ) {
    return value;
  }
  if (
    member.agentId === null ||
    baseAgent(context.settings, member.agentId) !==
      baseAgent(context.settings, agentId)
  ) {
    throw unsupported(
      `节点「${member.title}」跑的不是 ${agentId}，接不回它的会话。`,
    );
  }
  const session =
    getAgentStatus(context.database, member.id)?.sessionId ??
    reportedSession(member.data);
  if (session === undefined || !RESUME_ID.test(session)) {
    throw unsupported(`节点「${member.title}」还没有报过会话 id，接不回。`);
  }
  return session;
}

function reportedSession(data: Record<string, unknown>): string | undefined {
  const agent = data.agent;
  if (agent === null || typeof agent !== "object") return undefined;
  const id = (agent as Record<string, unknown>).sessionId;
  return typeof id === "string" && id !== "" ? id : undefined;
}
