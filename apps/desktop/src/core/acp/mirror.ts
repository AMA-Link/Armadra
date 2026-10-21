import { join } from "node:path";

import {
  ACP_MIRROR_SUFFIX,
  type MirrorEntry,
  mirrorSize,
  readMirrorEntries,
} from "../history/acp-mirror";

/**
 * ACP 会话的旧镜像：只读的那一半（会话时间线设计 §10，B10）。
 *
 * `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`，升级前的 core 逐条写下的
 * 会话。现在 core 不再写它——会话内容只进时间线（契约 §82）。留着读，是为了：
 *
 *   * 打开升级前的会话时，时间线还是空的，`mirror-import.ts` 把这份文件导入时间线；
 *   * 上下文读取、摘要、交接遇到时间线为空的旧会话，仍按文件读（`history/acp-mirror.ts`）。
 */

/** 文件名里的会话 id：只留安全字符，截长。 */
function fileComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? "session"
    : cleaned;
}

export function mirrorDirectory(dataDir: string, nodeId: string): string {
  return join(dataDir, "acp", fileComponent(nodeId));
}

export function mirrorPath(
  dataDir: string,
  nodeId: string,
  sessionId: string,
): string {
  return join(
    mirrorDirectory(dataDir, nodeId),
    `${fileComponent(sessionId)}${ACP_MIRROR_SUFFIX}`,
  );
}

export class AcpMirror {
  constructor(readonly path: string) {}

  /** 镜像是空的（文件不在或零字节）。 */
  get empty(): boolean {
    return mirrorSize(this.path) === 0;
  }

  get size(): number {
    return mirrorSize(this.path);
  }

  /** 从 `after` 起的记录，连图片、资源链接与差异一起读。 */
  read(after = 0): { entries: MirrorEntry[]; endOffset: number } {
    const range = readMirrorEntries(this.path, after, 32 * 1024 * 1024, {
      rich: true,
    });
    return { entries: [...range.entries], endOffset: range.endOffset };
  }
}
