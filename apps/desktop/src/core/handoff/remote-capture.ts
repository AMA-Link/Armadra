/**
 * 跨执行主机交接的控制端一侧（契约 §21.1，设计见补全架构 §9.2）。
 *
 * 来源 Agent 跑在一个 SSH 终端里，而那台主机不是工作空间所在的机器：它的转录
 * 在那台主机上，工作空间的文件与仓库在另一处。文件引用与 Git 指纹照旧在工作
 * 空间所在的机器上读（路径是相对工作空间根的）；转录尾巴要到来源那台主机上读，
 * 经那边 Worker 的 `handoff.capture`（`transcriptOnly`），与本机同一个读法——
 * 同一组历史适配器归一化。
 *
 * 能读的前提：那台主机在执行主机登记里、配了 Worker、Worker 连得上并提供
 * `remote.handoff.v1`。任何一条不满足都答 501 `handoff_host_offline`，不回退到
 * 读控制端磁盘上同名的路径——那是另一台机器上的另一份文件。
 *
 * 目标在哪台主机都可以：交出去的材料是文本与相对路径。
 */

import { executeRemote } from "../remote/execute";
import { DomainError } from "../workspaces/support";
import {
  TRANSCRIPT_TAIL_BYTES,
  type TranscriptSource,
  type TranscriptTail,
} from "./capture";
import {
  type RangeAnswer,
  type RangeRequest,
  type FrozenCursor,
  rangeAnswerOf,
} from "./source-range";

/** 来源主机不在、没有 Worker 或连不上（契约 §21.1）。 */
export const HANDOFF_HOST_OFFLINE = "handoff_host_offline";

/** 能在上面采集的主机：登记里的名字与是否配了 Worker。 */
export interface CaptureHost {
  readonly name: string;
  readonly worker?: unknown;
}

export type CaptureHostResolver = (hostId: string) => CaptureHost | undefined;

/** 把一个动作发给那台主机的 Worker（缺省经远端域，`remote/execute.ts`）。 */
export type CaptureCaller = (
  hostId: string,
  operation: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * 缺省没有主机：执行主机登记由远端域装配时经 {@link setCaptureHosts} 接上
 * （`remote/index.ts`）。没装配远端域的 core 本来也连不了任何 Worker。
 */
const noHosts: CaptureHostResolver = () => undefined;

let resolver: CaptureHostResolver = noHosts;
let caller: CaptureCaller = async (hostId, operation, args) =>
  await executeRemote(hostId, operation, "/", args);

/** 接上（或换掉）执行主机登记；返回之前那一个。 */
export function setCaptureHosts(
  next?: CaptureHostResolver,
): CaptureHostResolver {
  const previous = resolver;
  resolver = next ?? noHosts;
  return previous;
}

/** 测试换掉远端调用；返回之前那一个。 */
export function setCaptureCaller(next?: CaptureCaller): CaptureCaller {
  const previous = caller;
  caller =
    next ??
    (async (hostId, operation, args) =>
      await executeRemote(hostId, operation, "/", args));
  return previous;
}

export interface RemoteTranscript {
  /** 转录在哪台执行主机上读的。 */
  readonly capturedOn: string;
  readonly transcript: TranscriptTail;
}

function offline(message: string): DomainError {
  return new DomainError(501, HANDOFF_HOST_OFFLINE, message);
}

/**
 * 来源那台主机能不能采集：登记里有、配了 Worker。不连接——连接在
 * {@link captureTranscript} 里，失败同样是 `handoff_host_offline`。
 */
export function requireCaptureHost(hostId: string): CaptureHost {
  const host = resolver(hostId);
  if (host === undefined) {
    throw offline(
      `跨执行主机交接不可用：来源 Agent 的 SSH 主机 '${hostId}' 没有登记为执行主机`,
    );
  }
  if (host.worker === undefined) {
    throw offline(
      `跨执行主机交接不可用：执行主机 ${host.name} 没有配置 Worker，读不到来源 Agent 的转录`,
    );
  }
  return host;
}

/** 到 `hostId` 上读来源 Agent 的转录尾巴。 */
export async function captureTranscript(
  hostId: string,
  source: TranscriptSource,
): Promise<RemoteTranscript> {
  const host = requireCaptureHost(hostId);
  let answer: unknown;
  try {
    answer = await caller(hostId, "handoff.capture", {
      paths: [],
      execute: false,
      executionHost: `execution-host:${hostId}`,
      transcriptOnly: true,
      transcript: { ...source },
    });
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw offline(
      `跨执行主机交接不可用：执行主机 ${host.name} 的 Worker 不在线（${reason}）`,
    );
  }
  return { capturedOn: hostId, transcript: tailOf(answer) };
}

function cursorOf(value: unknown): FrozenCursor | undefined {
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return undefined;
  if (
    typeof raw.locatedKey !== "string" ||
    raw.locatedKey === "" ||
    typeof raw.endOffset !== "number" ||
    !Number.isSafeInteger(raw.endOffset) ||
    raw.endOffset < 0 ||
    (raw.unit !== "bytes" && raw.unit !== "entries" && raw.unit !== "opaque") ||
    (raw.prefixSha256 !== null && typeof raw.prefixSha256 !== "string")
  ) {
    return undefined;
  }
  return {
    locatedKey: raw.locatedKey,
    endOffset: raw.endOffset,
    prefixSha256: raw.prefixSha256 as string | null,
    unit: raw.unit,
  };
}

/**
 * Worker 的答复是外来数据：只认三种形状，文本超过尾巴上限（加一点余量给
 * 归一化后的 JSONL）当作读不了，而不是照单全收。
 */
export function tailOf(answer: unknown): TranscriptTail {
  const tail = (answer as { transcript?: unknown } | null)?.transcript as
    | { state?: unknown; text?: unknown }
    | undefined;
  if (tail === undefined || tail === null || typeof tail !== "object") {
    return { state: "missing" };
  }
  if (tail.state === "read" && typeof tail.text === "string") {
    if (Buffer.byteLength(tail.text, "utf8") > TRANSCRIPT_TAIL_BYTES * 2) {
      return { state: "unreadable" };
    }
    const cursor = cursorOf((tail as { cursor?: unknown }).cursor);
    return {
      state: "read",
      text: tail.text,
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
  if (tail.state === "unreadable") return { state: "unreadable" };
  return { state: "missing" };
}

/**
 * 到 `hostId` 上按游标读一页来源转录（`transcriptRange`，契约 §21.1）。主机不在、
 * 没有 Worker、连不上、Worker 太旧不认 range 都是 501 `handoff_host_offline`。
 */
export async function captureRange(
  hostId: string,
  request: RangeRequest,
): Promise<RangeAnswer> {
  const host = requireCaptureHost(hostId);
  let answer: unknown;
  try {
    answer = await caller(hostId, "handoff.capture", {
      paths: [],
      execute: false,
      executionHost: `execution-host:${hostId}`,
      transcriptOnly: true,
      transcriptRange: { ...request },
    });
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw offline(
      `跨执行主机交接不可用：执行主机 ${host.name} 的 Worker 不在线（${reason}）`,
    );
  }
  const range = rangeAnswerOf((answer as { range?: unknown } | null)?.range);
  if (range === undefined) {
    throw offline(
      `跨执行主机交接不可用：执行主机 ${host.name} 的 Worker 不支持按游标读转录，请升级它`,
    );
  }
  return range;
}
