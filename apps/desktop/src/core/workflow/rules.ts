import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stripControl } from "../collab/refusals";
import { getWorkspace } from "../workspaces/table";

/**
 * 协调者的接单规则文件（契约 §104.3，#830）：`<工作区根>/.armadra/router/rules.md`，
 * 人写的自然语言，没有机器字段。允许名单与模式不在这里（在 `router_sources`），
 * 文件里写了也不算数。
 *
 *   * 只从工作区根读，不从 worktree 读；每次现读，不缓存。
 *   * 上限 {@link MAX_RULES_BYTES}：超过的截断并在末尾加一行标注，哈希仍按全文算
 *     ——模型看到的与人确认的是同一份。
 *   * 哈希：sha256 的前 16 位十六进制。空文件与不存在都算缺失（哈希为空串）。
 *   * 工作区在远端执行主机上时本机读不到，答 `remote`，当缺失处理。
 */

/** 相对工作区根的位置。 */
export const RULES_PATH = ".armadra/router/rules.md";
/** 交给模型的上限（字节）。 */
export const MAX_RULES_BYTES = 16 * 1024;
/** 截断时末尾加的那一行。 */
export const RULES_TRUNCATED_NOTE = "[规则文件超过 16 KB，已截断]";

export interface RulesRead {
  /** 文件存在且非空。 */
  readonly present: boolean;
  /** 工作区在远端执行主机上，本机读不到。 */
  readonly remote: boolean;
  /** 全文哈希；缺失是空串。 */
  readonly hash: string;
  /** 交给模型的正文：去控制字符，超长截断并标注。 */
  readonly text: string;
  readonly truncated: boolean;
}

const MISSING: RulesRead = {
  present: false,
  remote: false,
  hash: "",
  text: "",
  truncated: false,
};

/** sha256 的前 16 位十六进制。 */
export function rulesHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** 把文件字节变成交给模型的正文与哈希。 */
export function rulesOf(bytes: Uint8Array): RulesRead {
  if (bytes.byteLength === 0) return MISSING;
  const truncated = bytes.byteLength > MAX_RULES_BYTES;
  let text = new TextDecoder("utf-8").decode(
    truncated ? bytes.subarray(0, MAX_RULES_BYTES) : bytes,
  );
  // 截在多字节字符中间时解码出替换字符，去掉它。
  if (truncated) text = text.replace(/�+$/u, "");
  text = stripControl(text);
  if (truncated) text = `${text.replace(/\n*$/, "")}\n${RULES_TRUNCATED_NOTE}`;
  return {
    present: true,
    remote: false,
    hash: rulesHash(bytes),
    text,
    truncated,
  };
}

/** 读一个本机根目录下的规则文件；读不到当缺失。 */
export function readRulesAt(root: string): RulesRead {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(root, RULES_PATH));
  } catch {
    return MISSING;
  }
  return rulesOf(bytes);
}

/** 工作区的规则文件。远端工作区答 `remote`（当缺失）。 */
export function readRules(
  database: DatabaseSync,
  workspaceId: string,
): RulesRead {
  let workspace;
  try {
    workspace = getWorkspace(database, workspaceId);
  } catch {
    return MISSING;
  }
  if ((workspace.executionHostId ?? "") !== "") {
    return { ...MISSING, remote: true };
  }
  return readRulesAt(workspace.rootPath);
}
