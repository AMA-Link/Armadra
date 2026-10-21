import { z } from "zod";

import { errors } from "./errors.js";
import { jsonValueSchema } from "./json.js";
import { meta, oc } from "./meta.js";
import { terminalSessionWireSchema } from "./terminals.js";

/**
 * `acp.*`（契约 §43.1）：ACP 驱动的会话——起会话、发提示、打断、切模式与模型、
 * 读镜像、切换驱动。会话就是 `terminal_sessions` 的一行（§14.2），所以起会话的
 * 出参就是终端会话行（{@link terminalSessionWireSchema}）。
 *
 * 入参只校形状：缺没缺字段、权限模式认不认识、驱动是不是 `acp` / `terminal`
 * 还在域里判，旧路径与 procedure 走同一份实现，拒绝的码与原话一样；所以这里
 * 不加会让入参校验抢在域前面拒绝的 `min` / 枚举。
 *
 * **投递与审批语义不变**：提示照旧是人类驾驶者写进会话（与终端里敲键同一条
 * 租约语义），不替人回答权限提示；审批卡片的答复不在这里，走 `agents.answerApproval`
 * （§39.3，`approval:answer`）。服务器壳上往别人起的会话里写、切换别人节点的驱动
 * 要 `terminal:drive`，按会话行 / 节点查出画布再判（`identity/route-access.ts`），
 * 旧路径与 procedure 过同一道门。
 *
 * 镜像读（`log`）与 `acp.update` 事件已在 B10 下线：会话内容读 `timeline.*`
 * （契约 §82）。
 */

/** 已知字段 + 原样透传其余字段（页面 schema 是 `looseObject` 的那些）。 */
function loose<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape).catchall(jsonValueSchema.optional());
}

const SESSION = "/api/acp/sessions/{sessionId}";
const base = { since: "1.12", contract: "§43.1" } as const;
const sessionRef = z.object({ sessionId: z.string().min(1) });

export const acp = {
  /**
   * 起会话；同一个节点已有活着的 ACP 会话时答那一行，结束了的在同一行上起下一代
   * 并接回。`prompt` 在会话开好后作为第一条提示发出。
   */
  createSession: oc
    .input(
      z.object({
        workspaceId: z.string().optional(),
        nodeId: z.string().optional(),
        cwd: z.string().optional(),
        agentId: z.string().optional(),
        permissionMode: z.string().optional(),
        model: z.string().optional(),
        resume: z.string().optional(),
        prompt: z.string().optional(),
      }),
    )
    .output(terminalSessionWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: { method: "POST", path: "/api/acp/sessions" },
      }),
    ),
  /**
   * 发一条提示：与终端里敲键同一个人类驾驶者；答这一回合的标识。带
   * `clientTurnId`（§39.9）时同一会话同一 id 只投递一次，重发答同一个回合。
   * `attachments`（§56）是这台 core 上 `agent-uploads` 的 id，随文字一起发。
   */
  prompt: oc
    .input(
      sessionRef.extend({
        text: z.string().optional(),
        clientTurnId: z.string().optional(),
        attachments: z.array(z.object({ uploadId: z.string() })).optional(),
      }),
    )
    .output(loose({ turnId: z.string() }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: { method: "POST", path: `${SESSION}/prompt` },
      }),
    ),
  /** 打断这一轮：一个 ESC，与节点头「打断这一轮」同一个原语；答 204。 */
  cancel: oc
    .input(sessionRef)
    .output(z.void())
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: {
          method: "POST",
          path: `${SESSION}/cancel`,
          successStatus: 204,
        },
      }),
    ),
  /** 切会话模式；答 204。 */
  setMode: oc
    .input(sessionRef.extend({ modeId: z.string().optional() }))
    .output(z.void())
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: {
          method: "POST",
          path: `${SESSION}/mode`,
          successStatus: 204,
        },
      }),
    ),
  /** 落模型（`session/set_config_option`，§26.2）；目录里没有时 409；答 204。 */
  setModel: oc
    .input(sessionRef.extend({ modelId: z.string().optional() }))
    .output(z.void())
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: {
          method: "PUT",
          path: `${SESSION}/model`,
          successStatus: 204,
        },
      }),
    ),
  /**
   * 切换驱动（`acp` ↔ `terminal`）：审批挂着就拒；在同一行上以另一种驱动起下一代，
   * 用 CLI 自己的会话 id 接回，接不回就新开并如实答 `resumed: false`。
   */
  switchDriver: oc
    .input(
      z.object({ nodeId: z.string().min(1), driver: z.string().optional() }),
    )
    .output(loose({ sessionId: z.string(), resumed: z.boolean() }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: { method: "POST", path: "/api/acp/nodes/{nodeId}/driver" },
      }),
    ),
};
