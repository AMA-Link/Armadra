/**
 * 终端输出进时间线（ACP 渐进式展示设计 §6，B9）。
 *
 * Agent 在 `tool_call` / `tool_call_update` 里用 `{ type: "terminal", terminalId }`
 * 把一个终端挂到工具上；输出本身 Agent 看不见也不发，由 core 的
 * {@link AcpTerminals} 攒着。这里把两头接起来：
 *
 *   * {@link TerminalFeedLink.decorate}：Agent 发来的更新里凡是没带输出的终端内
 *     容，补上 core 此刻的输出尾部与退出码——Agent 之后再发一次只有
 *     `terminalId` 的更新（内容整体替换）也不会把输出冲掉；
 *   * {@link TerminalFeedLink.updateFor}：终端输出或退出码变了，合成一条
 *     `tool_call_update`，走 `AcpFeed.update` 同一条路写进工具条目。
 *
 * 只给时间线用：旧的 `acp.update` 与镜像拿到的仍是 Agent 的原话（旧视图不显示
 * 终端内容）。
 */

import type { TerminalSnapshot } from "./terminals";

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** 时间线终端内容里的那几个字段。 */
function terminalEntry(snapshot: TerminalSnapshot): Json {
  return {
    type: "terminal",
    terminalId: snapshot.terminalId,
    command: snapshot.command,
    output: snapshot.output,
    ...(snapshot.truncated
      ? { truncated: true, originalBytes: snapshot.totalBytes }
      : {}),
    // 被信号杀掉：没有退出码，记 `null`（页面据此显示「已终止」）。
    ...(snapshot.exit === null ? {} : { exitCode: snapshot.exit.exitCode }),
  };
}

/** 记住的终端 / 工具上限：一个会话跑过很多命令，旧的忘掉。 */
const REMEMBER_MAX = 32;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > REMEMBER_MAX) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
}

export class TerminalFeedLink {
  /** toolCallId → Agent 最后一次给的 `content`。 */
  private readonly contents = new Map<string, unknown[]>();
  /** terminalId → 它挂在哪个工具上。 */
  private readonly owners = new Map<string, string>();
  /** terminalId → 最后一次的样子（终端释放之后 Agent 的更新还要用）。 */
  private readonly last = new Map<string, TerminalSnapshot>();

  constructor(
    private readonly lookup: (
      terminalId: string,
    ) => TerminalSnapshot | undefined,
  ) {}

  /**
   * Agent 的一条 `session/update`：不是带终端内容的工具更新就原样返回；是的话
   * 记下关联，返回补了输出的副本。
   */
  decorate<T>(update: T): T | Json {
    const body = obj(update);
    const kind = body?.sessionUpdate;
    if (
      body === null ||
      (kind !== "tool_call" && kind !== "tool_call_update")
    ) {
      return update;
    }
    const toolCallId = body.toolCallId;
    if (typeof toolCallId !== "string" || !Array.isArray(body.content)) {
      return update;
    }
    const content: unknown[] = body.content;
    let linked = false;
    const next = content.map((entry) => {
      const e = obj(entry);
      if (e === null || e.type !== "terminal") return entry;
      const terminalId = e.terminalId;
      if (typeof terminalId !== "string") return entry;
      linked = true;
      remember(this.owners, terminalId, toolCallId);
      const snapshot = this.lookup(terminalId) ?? this.last.get(terminalId);
      return snapshot === undefined || e.output !== undefined
        ? entry
        : { ...e, ...terminalEntry(snapshot) };
    });
    if (!linked) {
      // 这条更新把终端内容换没了：之后不再往这个工具上合成。
      if (this.contents.has(toolCallId)) {
        remember(this.contents, toolCallId, content);
      }
      return update;
    }
    remember(this.contents, toolCallId, content);
    return { ...body, content: next };
  }

  /** 终端变了：要喂给时间线的 `tool_call_update`；终端没挂在任何工具上时 `undefined`。 */
  updateFor(snapshot: TerminalSnapshot): Json | undefined {
    remember(this.last, snapshot.terminalId, snapshot);
    const toolCallId = this.owners.get(snapshot.terminalId);
    if (toolCallId === undefined) return undefined;
    const known = this.contents.get(toolCallId) ?? [];
    const entry = terminalEntry(snapshot);
    let replaced = false;
    const content = known.map((item) => {
      const e = obj(item);
      if (e?.type === "terminal" && e.terminalId === snapshot.terminalId) {
        replaced = true;
        return entry;
      }
      return item;
    });
    if (!replaced) content.push(entry);
    return { sessionUpdate: "tool_call_update", toolCallId, content };
  }
}
