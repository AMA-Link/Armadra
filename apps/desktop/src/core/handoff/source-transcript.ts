import type { HandoffBundle } from "./bundle";
import { captureRange } from "./remote-capture";
import {
  type RangeAnswer,
  type RangeRequest,
  PAGE_BYTES,
  readSourceRange,
} from "./source-range";

/**
 * `handoff-read --part transcript`：来源转录从头到冻结边界，分页（契约 §21.1）。
 *
 * 授权不在这里：调用方（`store.ts::readForCaller`）已经判完被寻址的会话、代次、撤回
 * 与连线。这里只回答「这份包能读到什么」：
 *
 *   * 版本 1 的包、没记游标的包：只有冻结摘录；
 *   * 文件来源的前缀哈希对不上，或来源读不到了：退回冻结摘录并标 `transcriptChanged`；
 *   * 否则按游标读一页，各家 CLI 一个形状；`raw` 给同一范围的原文。
 */

export interface TranscriptReadOptions {
  readonly cursor?: number | undefined;
  /** 一页最多多少条（原文：多少行），只能比 32 KB 的页上限更窄。 */
  readonly limit?: number | undefined;
  readonly raw?: boolean | undefined;
}

const LOCAL_PREFIX = "execution-host:";

function hostIdOf(label: string): string {
  return label.startsWith(LOCAL_PREFIX) ? label.slice(LOCAL_PREFIX.length) : "";
}

function head(bundle: HandoffBundle): Record<string, unknown> {
  return {
    part: "transcript",
    handoffId: bundle.handoffId,
    source: {
      agentId: bundle.source.agentId,
      provider: bundle.source.provider,
      nodeTitle: bundle.source.nodeTitle,
    },
  };
}

function excerpt(
  bundle: HandoffBundle,
  why: string,
  changed: boolean,
): Record<string, unknown> {
  return {
    ...head(bundle),
    mode: "excerpt",
    reason: why,
    transcriptExcerpt: bundle.transcriptExcerpt,
    nextCursor: null,
    done: true,
    ...(changed ? { transcriptChanged: true } : {}),
  };
}

export async function readSourceTranscript(
  bundle: HandoffBundle,
  options: TranscriptReadOptions = {},
): Promise<Record<string, unknown>> {
  const cursor = bundle.sourceCursor;
  if (bundle.version < 2) {
    return excerpt(
      bundle,
      "该交接是 v1 包，只有冻结时的摘录，没有可往后读的游标。",
      false,
    );
  }
  if (cursor === undefined) {
    return excerpt(
      bundle,
      "冻结时没有读到来源转录的末尾，只有冻结摘录。",
      false,
    );
  }
  const request: RangeRequest = {
    agentId: cursor.agentId,
    locatedKey: cursor.locatedKey,
    unit: cursor.unit,
    endOffset: cursor.endOffset,
    prefixSha256: cursor.prefixSha256,
    ...(cursor.lastEntrySha256 === undefined
      ? {}
      : { lastEntrySha256: cursor.lastEntrySha256 }),
    fromOffset: options.cursor ?? 0,
    maxBytes: PAGE_BYTES,
    ...(options.limit === undefined
      ? {}
      : { maxItems: Math.max(1, options.limit) }),
    raw: options.raw === true,
  };
  const hostId = hostIdOf(cursor.executionHost);
  const answer: RangeAnswer =
    hostId === ""
      ? readSourceRange(request)
      : await captureRange(hostId, request);
  switch (answer.state) {
    case "changed":
      return excerpt(
        bundle,
        "来源转录在冻结之后被改写或压缩，前缀对不上；改给冻结时的摘录。",
        true,
      );
    case "missing":
      return excerpt(bundle, "来源转录现在读不到；改给冻结时的摘录。", true);
    case "badCursor":
      throw new RangeError("游标无效：用上一页答复里的 nextCursor。");
    case "ok":
      return {
        ...head(bundle),
        mode: request.raw ? "raw" : "entries",
        ...(request.raw
          ? {
              rawLines: answer.rawLines ?? [],
              ...(answer.truncatedLines
                ? { truncatedLines: answer.truncatedLines }
                : {}),
            }
          : { entries: answer.entries ?? [] }),
        ...(answer.skippedLines ? { skippedLines: answer.skippedLines } : {}),
        ...(answer.lastEntryChanged
          ? {
              lastEntryChanged: true,
              lastEntryNote:
                "来源最后一条在冻结之后还在变，这里没给；它冻结时的样子在包的 transcriptExcerpt 里。",
            }
          : {}),
        nextCursor: answer.done ? null : answer.nextOffset,
        done: answer.done,
        cursorText: answer.cursorText,
        unit: cursor.unit,
      };
  }
}
