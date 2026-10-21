/**
 * 一家 CLI 的转录适配器（设计 §5.1）。
 *
 * 读多少、何时读、游标怎么存都由尾读器和管理器负责；适配器只回答三件事：
 *
 *   * 转录文件在哪（{@link TranscriptAdapter.locate}，线索来自 `agent_status`）；
 *   * 一行 JSON 说了什么（{@link TranscriptAdapter.convert}，通过 {@link TimelineSink}
 *     写时间线，转换器自己不持有跨行状态——当前回合、已开的工具都从时间线读）；
 *   * hook 事件在活动层怎么显示（{@link TranscriptAdapter.toolKind}，给活动的 `toolKind`）。
 *
 * OpenCode、Pi / OMP、Copilot 照这个形状各写一个文件，在 `index.ts` 的
 * {@link ADAPTERS} 里登记一行即可。不是逐行 JSONL 的来源（OpenCode 的 SQLite）
 * 实现 {@link TranscriptAdapter.source}：自己造读取器，读到的记录仍序列化成一行
 * JSON 交给 `convert`，游标是它自己的不透明字符串。
 */

import type { SessionHint } from "../../history/types";
import type { TimelineSink } from "./sink";
import type { StatFn, TailTimers, WatchFn } from "./tailer";

/** 管理器对读取器的全部要求：{@link TailRunner} 与非文件来源的读取器都满足。 */
export interface SourceRunner {
  start(): void;
  /** hook 响了：稍后读一次并补读，`then` 在补读之后调。 */
  poke(then?: () => void): void;
  readNow(): void;
  /** 线索变了（路径、会话 id）：下一次读之前重新定位。 */
  relocate(): void;
  stop(): void;
}

/** 非文件来源一次读到的东西。 */
export interface RecordBatch {
  /** 每条一行 JSON，交给 `convert`。 */
  readonly lines: string[];
  /** 新游标（不透明字符串，存进 `source_cursor`）。 */
  readonly cursor: string | undefined;
  /** 不是接着游标读的（第一次、会话换了）：这一批当回填，不推进活动层。 */
  readonly reset: boolean;
}

export interface RecordSourceOptions {
  /** 当前线索（会话 id 随 hook 更新）。 */
  readonly hint: () => SessionHint;
  readonly initialCursor: string | undefined;
  readonly onRead: (batch: RecordBatch) => void;
  readonly onError: (error: unknown) => void;
  readonly timers?: TailTimers | undefined;
  readonly watch?: WatchFn | undefined;
  readonly stat?: StatFn | undefined;
}

export interface TranscriptAdapter {
  /** 与 `agent_status.agent_id` 的基础 id 一致。 */
  readonly agentId: string;
  /** 转录文件的绝对路径；定位不到答 `undefined`（尾读器稍后重试）。 */
  locate(hint: SessionHint): string | undefined;
  /**
   * 一行解析后的 JSON → 时间线。形状不可信：不认识的记录忽略，缺字段的跳过，
   * 不抛错（抛了也只丢这一行，见管理器）。
   */
  convert(record: unknown, sink: TimelineSink): void;
  /** hook 里的工具名 → 时间线工具 kind（活动的 `toolKind`）。 */
  toolKind(toolName: string): string;
  /**
   * 来源不是 JSONL 文件时的读取器工厂；有它就不走尾读器。`locate` 仍可答一个路径
   * （OpenCode 答库文件，只用来判断「这台机器上有没有」）。
   */
  source?(options: RecordSourceOptions): SourceRunner;
}
