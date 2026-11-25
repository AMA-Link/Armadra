import type { AcpToolCallUpdate } from "@armadra/agent/acp";

/**
 * 以 `_` 开头的扩展请求（ACP 规范留给各家的位置）里，需要人决定的那一类。
 *
 * 目前只有 grok 的 `_x.ai/exit_plan_mode`：grok 在 plan 模式下把计划交给客户端审批，
 * 请求在人答之前一直挂着。它进审批挂起表（与 `session/request_permission` 同一张，
 * `AcpProcess.holdExt`），卡片正文是计划，选项是「批准 / 拒绝」；人**批准**之后，经
 * 适配器里**这一处**映射函数（{@link AcpExtRequestSpec.reply}）变成应答 JSON。
 *
 * 红线与失效安全：
 *   * 绝不自动代答；
 *   * **只有人点了批准才回成功的 `result`**。拒绝、没选、没有审批消费者（无人值守）、
 *     会话被取消、进程退出，全部抛 `RpcError`（-32800），JSON-RPC 的错误不可能被对端读成
 *     批准——哪怕映射函数的应答形状是错的；
 *   * 应答形状没核实过的规格（`verified: false`）根本不挂卡：保持现状的 -32601
 *     （method not found），依赖升级也不会让一个没核实的应答自动上线。
 */

/** 卡片正文最多这么多字符，多的截断并加省略标记。 */
export const MAX_PLAN_CHARS = 64 * 1024;

export interface ExtRequestCard {
  readonly sessionId: string;
  /** 关联到 Agent 那边的工具调用。 */
  readonly toolCallId: string;
  /** 兜底标题；页面认审批条目上 core 自己写的 `card: "plan"`，按语言显示自己的。 */
  readonly title: string;
  /** 卡片正文：计划原文，清洗过（见 {@link plainBody}）、截到 {@link MAX_PLAN_CHARS}。 */
  readonly body: string;
  /** 正文被截断时，原文有多少个字符（码点）。 */
  readonly bodyChars?: number;
}

export interface AcpExtRequestSpec {
  readonly kind: "plan-approval";
  /**
   * 应答形状核实过没有（用真账号抓过批准的应答、对过映射）。`false` 的规格不挂卡，
   * 请求照旧回 -32601。核实之后改这一个标志和 {@link reply}，别的都不用动。
   */
  readonly verified: boolean;
  /** 请求参数 → 卡片；参数不认识时答 `undefined`（回 invalid params，不挂卡）。 */
  card(params: unknown): ExtRequestCard | undefined;
  /**
   * 人批准了 → 应答 JSON（原样作为 JSON-RPC 的 `result`）。只在批准时调用；别的
   * 情况一律抛 `RpcError`，不经这里。
   *
   * **应答形状没有用真账号核对过**（Armadra#1021）：目前只知道请求的形状
   * （`sessionId`、`toolCallId`、`planContent`），不知道 grok 认哪些应答字段。
   */
  reply(params: unknown): unknown;
}

/**
 * ESC 序列：CSI（`ESC [ … 终结符`）、**有终结符、不跨行、不超过 4096 字符**的 OSC
 * （`ESC ] … BEL | ESC \`），以及其余两字节的 ESC 序列——没有终结符的 `ESC ]`
 * 落在这最后一支里，只删这两个字符，不会吞掉后面的计划正文。
 */
const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]{0,4096}(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/**
 * 看不见、却会改变显示或藏东西的字符：换成看得见的 `[U+XXXX]` 占位。双向控制（含
 * U+061C、U+200E/F、U+202A–E、U+2066–9）、零宽与不可见格式字符（U+00AD、U+115F、
 * U+180E、U+200B–D、U+2060–4、U+3164、U+FEFF、U+FFF9–B）、行 / 段分隔符
 * （U+2028/9）、标签字符（U+E0000–E007F）。
 */
const INVISIBLES =
  /[\u00ad\u061c\u115f\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

/**
 * 计划原文 → 能放进卡片的纯文本：去掉 ESC 序列与 C0 / C1 控制字符（保留换行与
 * Tab，`\r` 去掉），不可见字符换成 `[U+XXXX]` 占位；清洗后超过 {@link MAX_PLAN_CHARS}
 * 就截断，且不从代理对中间切开。被截断时 `chars` 是**原文**的字符数（UTF-16 码元，
 * 与截断阈值同一个口径）；截断的提示（「已截断，共 N 字符」）由页面按语言写。
 */
export function plainBody(text: string): { body: string; chars?: number } {
  const clean = text
    .replace(ESCAPES, "")
    .replace(CONTROLS, "")
    .replace(
      INVISIBLES,
      (char) =>
        `[U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}]`,
    );
  if (clean.length <= MAX_PLAN_CHARS) return { body: clean };
  let end = MAX_PLAN_CHARS;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { body: clean.slice(0, end), chars: text.length };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** grok 的计划审批：请求 `{ sessionId, toolCallId, planContent }`。 */
export const GROK_EXIT_PLAN_MODE: AcpExtRequestSpec = {
  kind: "plan-approval",
  // 应答形状没有用真账号核对过：不挂卡（Armadra#1021 的第 2 步核对之后改成 true）。
  verified: false,
  card(params) {
    const value = record(params);
    const sessionId = value?.sessionId;
    const toolCallId = value?.toolCallId;
    if (typeof sessionId !== "string" || typeof toolCallId !== "string") {
      return undefined;
    }
    const plan = value?.planContent;
    const { body, chars } = plainBody(typeof plan === "string" ? plan : "");
    return {
      sessionId,
      toolCallId,
      title: "Plan",
      body,
      ...(chars === undefined ? {} : { bodyChars: chars }),
    };
  },
  // 未验证（Armadra#1021）：先按最朴素的猜测写。
  reply() {
    return { approved: true };
  },
};

/**
 * 卡片 → 审批挂起表里的那一条工具调用。只有标题、种类、状态：计划正文与「这是计划
 * 审批」的标记不放在这里（工具调用是 Agent 的东西，别的字段都可能被它伪造），放在
 * `AcpPendingPermission` 上只有 `holdExt` 才写的 `card` / `body` 字段。
 */
export function planToolCall(card: ExtRequestCard): AcpToolCallUpdate {
  return {
    toolCallId: card.toolCallId,
    title: card.title,
    kind: "switch_mode",
    status: "pending",
  };
}

/** 入站审批请求的 `toolCall._meta` 里去掉 `armadra/` 前缀的键：这个命名空间是 core 的。 */
export function scrubOwnMeta<T extends { readonly _meta?: unknown }>(
  toolCall: T,
): T {
  const meta = toolCall._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return toolCall;
  }
  const kept = Object.fromEntries(
    Object.entries(meta as Record<string, unknown>).filter(
      ([key]) => !key.startsWith("armadra/"),
    ),
  );
  return { ...toolCall, _meta: kept };
}
