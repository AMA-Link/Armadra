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
 * B4b 的 OpenCode、Pi / OMP、Copilot 照这个形状各写一个文件，在 `index.ts` 的
 * {@link ADAPTERS} 里登记一行即可。不是逐行 JSONL 的来源（OpenCode 的 SQLite）
 * 实现 {@link TranscriptAdapter.source} 自己的读法。
 */

import type { SessionHint } from "../../history/types";
import type { TimelineSink } from "./sink";

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
}
