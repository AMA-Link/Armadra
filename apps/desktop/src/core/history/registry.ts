import type { TimelineItem } from "@armadra/shared";

import {
  entriesFromTimeline,
  isAcpMirror,
  readMirrorEntries,
  sliceTimelineEntries,
} from "./acp-mirror";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { copilotAdapter } from "./copilot";
import { readLocatedEntries, reportedFile } from "./files";
import { opencodeAdapter } from "./opencode";
import { ompAdapter, piAdapter } from "./pi";
import type { EntryRange, HistoryAdapter, Located, SessionHint } from "./types";

/**
 * 本地历史适配器的注册表（设计 `cli-collaboration.md` §2）。
 *
 * 接入一家 CLI 的本地历史只有一条路径：写一个 {@link HistoryAdapter}，在
 * {@link HISTORY_ADAPTERS} 里加一行。会话索引的 provider 列表、成本来源表、转录
 * 定位与读取都从这里派生，不必再改调用方。顺序就是会话索引扫描与成本表的顺序。
 */
export const HISTORY_ADAPTERS: readonly HistoryAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  piAdapter,
  ompAdapter,
  copilotAdapter,
];

/**
 * ACP 会话时间线的读口（会话时间线设计 §10，B10）：节点的 `transcriptPath` 是旧
 * 镜像路径时，据它找到会话的时间线条目。没有时间线、时间线为空答 `undefined`，
 * 读取方退回按文件读旧镜像。由 `core/acp` 装配。
 */
export type AcpTimelineSource = (
  mirrorPath: string,
) => readonly TimelineItem[] | undefined;

let acpTimeline: AcpTimelineSource | undefined;

export function setAcpTimelineSource(source: AcpTimelineSource | undefined) {
  acpTimeline = source;
}

function timelineEntriesOf(path: string | undefined) {
  if (!isAcpMirror(path)) return undefined;
  const items = acpTimeline?.(path as string);
  if (items === undefined || items.length === 0) return undefined;
  const entries = entriesFromTimeline(items);
  return entries.length === 0 ? undefined : entries;
}

/** 这个 agent id 的适配器；自定义条目与还没接入的 CLI 是 `undefined`。 */
export function historyAdapter(agentId: string): HistoryAdapter | undefined {
  return HISTORY_ADAPTERS.find((adapter) => adapter.agentId === agentId);
}

/**
 * 某个节点的记录在哪。
 *
 * CLI 自己报来的转录路径永远先认，不论有没有适配器——Pi、OMP 的扩展会报，自定义
 * 条目借的是基础 agent 的 Hook，也会报。之后才轮到适配器自己的查找。
 */
export function locateHistory(hint: SessionHint): Located | undefined {
  return (
    reportedFile(hint.transcriptPath) ??
    timelineLocated(hint.transcriptPath) ??
    historyAdapter(hint.agentId)?.locate(hint)
  );
}

/** 旧镜像文件已经不在（core 不再写它），但会话的时间线有内容。 */
function timelineLocated(path: string | undefined): Located | undefined {
  if (path === undefined || timelineEntriesOf(path) === undefined) {
    return undefined;
  }
  return { key: path, path, origin: `ACP 会话时间线（${path}）` };
}

/**
 * 读一段归一化记录：有适配器经适配器，没有的按 JSONL 文件读（CLI 报来的路径）。
 * ACP 会话的转录（`.acp.jsonl` 路径，`acp-mirror.ts`）先认：时间线有内容就从时间线
 * 派生，否则读升级前的旧镜像；都不是这家 CLI 的形状，交给适配器就读不出来。I/O 失败照常抛出。
 */
export function readHistoryEntries(
  agentId: string,
  located: Located,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  if (isAcpMirror(located.path)) {
    // 时间线有内容就从时间线派生（游标是记录序号），否则读旧镜像文件。
    const derived = timelineEntriesOf(located.path);
    if (derived !== undefined) {
      return sliceTimelineEntries(derived, fromOffset, maxBytes);
    }
    return readMirrorEntries(located.path as string, fromOffset, maxBytes);
  }
  const adapter = historyAdapter(agentId);
  return adapter === undefined
    ? readLocatedEntries(located, fromOffset, maxBytes)
    : adapter.readEntries(located, fromOffset, maxBytes);
}

/**
 * 读取游标给读者看的样子：适配器说了算，没说的是文件来源，按字节。有 `path` 的
 * 定位结果按字节读（文件），哪怕这家的适配器另有游标。
 */
export function describeHistoryCursor(
  agentId: string,
  located: Located,
  offset: number,
): string {
  if (timelineEntriesOf(located.path) !== undefined) return `${offset} 条`;
  const describe = historyAdapter(agentId)?.describeCursor;
  return located.path === undefined && describe !== undefined
    ? describe(offset)
    : `${offset} 字节`;
}
