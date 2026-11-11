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
 * 也有 Agent 自己跑命令、不经客户端终端的：它在同一个工具更新的 `_meta` 里给输出块
 * （`terminal_output_delta` / `terminal_output`，`{ data, terminal_id }`，追加）
 * 与退出（`terminal_exit`，`{ exit_code, signal, terminal_id }`）；不显示终端的命令
 * 把退出码放在 `rawOutput.exit_code`。这些也在这里攒成尾部，并进同一份终端内容，
 * 工具条目没有终端内容时补一份。
 *
 * 只给时间线用：旧的 `acp.update` 与镜像拿到的仍是 Agent 的原话（旧视图不显示
 * 终端内容）。
 */

import { TOOL_TEXT_TAIL_BYTES } from "@armadra/shared";

import {
  CHANGE_INTERVAL_MS,
  TailBuffer,
  type TerminalSnapshot,
} from "./terminals";

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
    // Agent 自己跑的命令没有命令行（在工具的入参里）。
    ...(snapshot.command === "" ? {} : { command: snapshot.command }),
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

/** `_meta` 里输出块的两个键：`terminal_output_delta` 是缺省，`terminal_output` 是另一种约定。 */
const OUTPUT_KEYS = ["terminal_output_delta", "terminal_output"] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function exitCodeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * 只带输出块的更新：除了 `_meta` 的输出块没有别的（没有状态、标题、内容与退出）。
 * 这种可以节流。
 */
function chunkOnly(body: Json): boolean {
  for (const key of Object.keys(body)) {
    if (key !== "sessionUpdate" && key !== "toolCallId" && key !== "_meta") {
      return false;
    }
  }
  const meta = obj(body._meta);
  return meta !== null && meta.terminal_exit === undefined;
}

/** Agent 自己跑的命令：攒下的输出尾部与退出码（`undefined`：还在跑）。 */
interface AgentTerminal {
  readonly buffer: TailBuffer;
  exit: { exitCode: number | null } | undefined;
}

export class TerminalFeedLink {
  /** toolCallId → Agent 最后一次给的 `content`。 */
  private readonly contents = new Map<string, unknown[]>();
  /** terminalId → 它挂在哪个工具上。 */
  private readonly owners = new Map<string, string>();
  /** terminalId → 最后一次的样子（终端释放之后 Agent 的更新还要用）。 */
  private readonly last = new Map<string, TerminalSnapshot>();
  /** terminalId → Agent 自己跑的命令（经 `_meta` 报输出与退出）。 */
  private readonly agent = new Map<string, AgentTerminal>();

  /** toolCallId → 等着合成的那一次（只带输出块的更新节流过再进时间线）。 */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param emit 只带输出块的更新不逐块进时间线：攒 {@link CHANGE_INTERVAL_MS}
   *   合成一条 `tool_call_update` 交给它。不给就逐块补在原更新上。
   */
  constructor(
    private readonly lookup: (
      terminalId: string,
    ) => TerminalSnapshot | undefined,
    private readonly emit?: (update: Json) => void,
  ) {}

  /**
   * Agent 的一条 `session/update`：不是工具更新、也不带终端内容或 `_meta` 输出就
   * 原样返回；否则记下关联，返回补了输出的副本。
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
    if (typeof toolCallId !== "string") return update;
    const absorbed = this.absorb(body, toolCallId);
    const given = Array.isArray(body.content)
      ? (body.content as unknown[])
      : undefined;
    if (given === undefined && !absorbed) return update;
    if (given === undefined && this.emit !== undefined && chunkOnly(body)) {
      this.schedule(toolCallId);
      return update;
    }
    // 这一条带着此刻的输出进时间线，等着的那次合成不用了。
    this.cancel(toolCallId);
    // 没带 `content` 的更新只是输出与退出：在最后一次的内容上补。
    const content = given ?? this.contents.get(toolCallId) ?? [];
    const { next, linked } = this.fill(toolCallId, content);
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

  /** 会话结束：丢掉等着的合成。 */
  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** 内容里的终端补上此刻的输出；Agent 自己跑的命令没在内容里的，补一份。 */
  private fill(
    toolCallId: string,
    content: readonly unknown[],
  ): { next: unknown[]; linked: boolean } {
    let linked = false;
    const next = content.map((entry) => {
      const e = obj(entry);
      if (e === null || e.type !== "terminal") return entry;
      const terminalId = e.terminalId;
      if (typeof terminalId !== "string") return entry;
      linked = true;
      remember(this.owners, terminalId, toolCallId);
      const snapshot = this.snapshot(terminalId);
      return snapshot === undefined || e.output !== undefined
        ? entry
        : { ...e, ...terminalEntry(snapshot) };
    });
    // 不显示终端的命令、或之后一条更新把内容整体换掉：输出与退出码不能丢。
    for (const [terminalId] of this.agent) {
      if (this.owners.get(terminalId) !== toolCallId) continue;
      const present = next.some((entry) => {
        const e = obj(entry);
        return e?.type === "terminal" && e.terminalId === terminalId;
      });
      if (present) continue;
      const snapshot = this.snapshot(terminalId);
      if (snapshot === undefined) continue;
      linked = true;
      next.push(terminalEntry(snapshot));
    }
    return { next, linked };
  }

  private schedule(toolCallId: string): void {
    if (this.pending.has(toolCallId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(toolCallId);
      const content = this.contents.get(toolCallId) ?? [];
      const { next, linked } = this.fill(toolCallId, content);
      if (!linked) return;
      remember(this.contents, toolCallId, content);
      this.emit?.({
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: next,
      });
    }, CHANGE_INTERVAL_MS);
    timer.unref?.();
    this.pending.set(toolCallId, timer);
  }

  private cancel(toolCallId: string): void {
    const timer = this.pending.get(toolCallId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(toolCallId);
  }

  /**
   * 读工具更新 `_meta` 里的输出块与退出、`rawOutput.exit_code`，攒进
   * {@link agent}。有任何一项答 `true`。
   */
  private absorb(body: Json, toolCallId: string): boolean {
    let touched = false;
    const meta = obj(body._meta);
    if (meta !== null) {
      for (const key of OUTPUT_KEYS) {
        const chunk = obj(meta[key]);
        if (chunk === null || typeof chunk.data !== "string") continue;
        const terminal = this.agentTerminal(
          text(chunk.terminal_id) ?? toolCallId,
          toolCallId,
        );
        terminal.buffer.push(Buffer.from(chunk.data, "utf8"));
        touched = true;
      }
      const exit = obj(meta.terminal_exit);
      if (exit !== null) {
        const terminal = this.agentTerminal(
          text(exit.terminal_id) ?? toolCallId,
          toolCallId,
        );
        // 被信号杀掉：没有退出码，记 `null`。
        terminal.exit = { exitCode: exitCodeOf(exit.exit_code) };
        touched = true;
      }
    }
    const raw = obj(body.rawOutput);
    if (raw !== null && exitCodeOf(raw.exit_code) !== null) {
      const terminal = this.agentTerminal(toolCallId, toolCallId);
      terminal.exit ??= { exitCode: exitCodeOf(raw.exit_code) };
      touched = true;
    }
    return touched;
  }

  private agentTerminal(terminalId: string, toolCallId: string): AgentTerminal {
    remember(this.owners, terminalId, toolCallId);
    let terminal = this.agent.get(terminalId);
    if (terminal === undefined) {
      terminal = {
        buffer: new TailBuffer(TOOL_TEXT_TAIL_BYTES),
        exit: undefined,
      };
    }
    remember(this.agent, terminalId, terminal);
    return terminal;
  }

  /** 此刻的样子：客户端终端优先，其次 Agent 自己跑的，最后是记下的最后一次。 */
  private snapshot(terminalId: string): TerminalSnapshot | undefined {
    const live = this.lookup(terminalId);
    if (live !== undefined) return live;
    const agent = this.agent.get(terminalId);
    if (agent !== undefined) {
      return {
        terminalId,
        command: "",
        output: agent.buffer.text(),
        truncated: agent.buffer.truncated,
        totalBytes: agent.buffer.totalBytes,
        exit:
          agent.exit === undefined
            ? null
            : { exitCode: agent.exit.exitCode, signal: null },
      };
    }
    return this.last.get(terminalId);
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
