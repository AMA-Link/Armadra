/**
 * 压缩之后的一句提醒（契约 §101.7，#704）。
 *
 * ama 把长对话压缩成摘要之后，协调者手里关于工作项的印象只剩摘要里写下的那
 * 几句，可能已经过时。账本才是唯一事实来源，所以每次 `session_compact`，协调者
 * 预设下（没有 bash / edit / write）用 `messages.sendUser` 注入一句，来源标成宿
 * 主（`origin = "armadra"`，落盘在消息上，界面标为宿主发的，不是人说的话）。
 *
 * 只给协调者：成员和单机的 ama 不需要。运行中压缩时这条按 steer 入队，空闲时
 * 压缩（手动）会开一轮——宿主 API 没有「只落盘不开轮」的注入方式。
 */

import type { HostApi } from "@armadra/agent/host";
import { isCoordinator } from "./tools.js";

/** 消息上记的来源：与适配器 id 相同（`main.ts::ADAPTER_ID`）。 */
export const NOTE_ORIGIN = "armadra";

/** 注入的原文：中英各一句，开头标明是宿主发的。 */
export const COMPACTION_NOTE =
  "[宿主 Armadra] 对话刚被压缩。工作项与事件的现状以 `canvas_items` 与 `canvas_events` 为准，不要凭摘要或记忆判断。\n" +
  "[Host: Armadra] The conversation was just compacted. The current state is whatever `canvas_items` and `canvas_events` show; do not rely on the summary or on memory.";

/** 同一句，账本与事件改经 `armadra://` 资源读（host-api 1.2，#885）。 */
export const COMPACTION_NOTE_RESOURCES =
  "[宿主 Armadra] 对话刚被压缩。工作项与事件的现状以 `armadra://items` 与 `armadra://events`（用 `read` 读）为准，不要凭摘要或记忆判断。\n" +
  "[Host: Armadra] The conversation was just compacted. The current state is whatever `read armadra://items` and `read armadra://events` show; do not rely on the summary or on memory.";

type Api = Pick<HostApi, "events" | "tools" | "messages" | "log">;

/** 注入的那句：有 `armadra://` 资源时说资源，否则说工具。 */
export function compactionNote(options: { resources?: boolean } = {}): string {
  return options.resources === true
    ? COMPACTION_NOTE_RESOURCES
    : COMPACTION_NOTE;
}

/** 订阅 `session_compact`；答注销函数。 */
export function injectAfterCompaction(
  api: Api,
  options: { resources?: boolean } = {},
): () => void {
  const note = compactionNote(options);
  return api.events.on("session_compact", () => {
    if (!isCoordinator(api)) return undefined;
    return api.messages
      .sendUser(note, NOTE_ORIGIN)
      .then(() => undefined)
      .catch((error: unknown) => {
        api.log("warn", "compaction note was not injected", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}
