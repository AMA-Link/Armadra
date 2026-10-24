import type { SessionKey, TerminalBackend } from "./backend";

/**
 * 页面的终端对程序查询的应答（#518）：DA、DSR/CPR、DECRQM、DECRQSS、窗口报告、
 * OSC 颜色。同一个会话开着几个视图时每个都会答一遍，core 只留一份。
 *
 * 页面在 `input` 帧上标 `reply: true`；这里不信标记本身，只认**整段都是应答
 * 格式**的数据。应答里没有回车、没有可打印的裸字符，所以借这个标记绕过租约
 * 也敲不出一条命令。
 */

/** 最长的一段应答。颜色报告几十字节，DECRQSS 也不过百。 */
export const MAX_REPLY_LENGTH = 4096;

/**
 * `data` 是不是由一条或多条终端应答拼成：
 *
 *   * CSI：`ESC [`，参数只有数字、`;`、`?`、`>`，可带中间字节 `$`，终止符是
 *     `c`（DA）、`n`（DSR）、`R`（CPR）、`t`（窗口报告）或 `y`（DECRPM）；
 *   * OSC：`ESC ]` 到 BEL 或 `ESC \`，中间只有可打印 ASCII；
 *   * DCS：`ESC P` 到 `ESC \`，中间只有可打印 ASCII。
 */
export function isTerminalReplyData(data: string): boolean {
  if (data === "" || data.length > MAX_REPLY_LENGTH) return false;
  let index = 0;
  while (index < data.length) {
    const next = replyEnd(data, index);
    if (next === undefined) return false;
    index = next;
  }
  return true;
}

/** One reply starting at `start`; returns the index just past it. */
export function replyEnd(data: string, start: number): number | undefined {
  if (data[start] !== "\x1b") return undefined;
  const kind = data[start + 1];
  if (kind === "[") {
    let index = start + 2;
    while (index < data.length && /[0-9;?>]/.test(data[index]!)) index += 1;
    if (data[index] === "$") index += 1;
    return "cnRty".includes(data[index] ?? "\n") && index < data.length
      ? index + 1
      : undefined;
  }
  if (kind === "]" || kind === "P") {
    for (let index = start + 2; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (kind === "]" && code === 0x07) return index + 1;
      if (code === 0x1b)
        return data[index + 1] === "\\" ? index + 2 : undefined;
      if (code < 0x20 || code > 0x7e) return undefined;
    }
  }
  return undefined;
}

/**
 * Writes one view's answer to a query the program sent. Every view answers,
 * so only one answer may reach the program:
 *
 *   * a backend with a view per viewer (tmux) sends it back down the
 *     sender's own client — tmux asked that client;
 *   * a backend with one pty takes what `firstOf` lets through — the first
 *     answer to each pending query (`QueryLedger`) — and drops the rest.
 *
 * A reply is not someone driving: no lease, no activity, no input revision.
 * The caller has checked that `data` is all replies (`isTerminalReplyData`).
 * Resolves to whether anything was written.
 */
export async function writeReply(
  backend: TerminalBackend,
  key: SessionKey,
  data: string,
  from: { attachmentId: number; firstOf: (data: string) => string },
): Promise<boolean> {
  if (backend.reply !== undefined) {
    await backend.reply(key, from.attachmentId, Buffer.from(data, "utf8"));
    return true;
  }
  const kept = from.firstOf(data);
  if (kept === "") return false;
  await backend.input(key, Buffer.from(kept, "utf8"));
  return true;
}
