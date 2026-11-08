import { hasCapability } from "../agent/registry";
import { acpSurfaceAvailable } from "../collab/control/agent-driver";
import {
  readModel,
  readPermissionMode,
  requireAgent,
} from "../collab/control/nodes";
import { cleanTitle } from "../collab/control/board";
import { Args, Refusal, Refused } from "../collab/refusals";
import type { CollabContext } from "../collab/service";
import { CoreFailure } from "../http/errors";
import type { NewTargetSpec } from "./bundle";

/**
 * 交接的「新开 Agent」目标（契约 §39.8，Issue #872）。
 *
 * 预览阶段只校验、不建节点：规格进冻结的包，所以用户看到的目标和批准时建出来
 * 的是同一份（digest 覆盖它）。校验复用 `open-agent` 自己的读参函数，错误码与
 * `open-agent` 一致；这里只多两条它没有的：这家 Agent 有没有上下文连线能力
 * （目标要能读交接），以及形态（终端 / ACP）这家支持不支持。
 */

/** `open-agent` 的拒绝改成 HTTP 域里抛的 {@link CoreFailure}，码不变。 */
export function asFailure(error: unknown): unknown {
  if (error instanceof Refused) {
    return new CoreFailure(
      error.status,
      error.code,
      error.message,
      error.detail,
    );
  }
  if (error instanceof Refusal) {
    const code =
      {
        400: "bad_request",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
      }[error.status] ?? "internal_error";
    return new CoreFailure(error.status, code, error.message);
  }
  return error;
}

function text(
  source: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = source[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new CoreFailure(
      400,
      "bad_request",
      `target.${name} must be a string`,
    );
  }
  return value;
}

/**
 * 校验并规范化 `target: { kind: "new", … }`。不存在、被关掉、没有连线能力、
 * 模型不是 1–120 个字符、权限模式不在这家支持的范围、形态这家不支持，都是 400
 * （被关掉的 Agent 是 403，同 `open-agent`）。
 */
export function validateNewTarget(
  context: CollabContext,
  raw: Record<string, unknown>,
): NewTargetSpec {
  try {
    const agentIdRaw = text(raw, "agentId");
    const agentId = requireAgent(context, agentIdRaw, "target.agentId 必填");
    if (!hasCapability(context.settings, agentId, "contextLink")) {
      throw new Refused(
        400,
        "target_agent_unsupported",
        `${agentId} 不支持上下文连线，不能作为交接目标。`,
      );
    }
    const surface = text(raw, "surface");
    if (surface !== "terminal" && surface !== "acp") {
      throw Refusal.badRequest("target.surface 只能是 terminal 或 acp。");
    }
    if (surface === "acp" && !acpSurfaceAvailable(context.settings, agentId)) {
      throw new Refused(
        400,
        "target_surface_unsupported",
        `${agentId} 在这台机器上没有可用的 ACP 适配器，不能以 ACP 形态开。`,
      );
    }
    const args = new Args({
      ...(text(raw, "model") === undefined
        ? {}
        : { model: text(raw, "model") }),
      ...(text(raw, "permissionMode") === undefined
        ? {}
        : { "permission-mode": text(raw, "permissionMode") }),
    });
    const model = readModel(args);
    const permissionMode = readPermissionMode(context, agentId, args);
    const titleRaw = text(raw, "title");
    const title =
      titleRaw === undefined || titleRaw.trim() === ""
        ? undefined
        : cleanTitle(titleRaw);
    return {
      kind: "new",
      agentId,
      ...(model === undefined ? {} : { model }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      surface,
      ...(title === undefined ? {} : { title }),
    };
  } catch (error) {
    throw asFailure(error);
  }
}
