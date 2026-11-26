/**
 * 会话板（`boards.kind = 'sessions'`，Armadra#1062 S4）上的会话没有画布，这几条
 * 动词在那里没有意义：core 当场拒绝（`VERB_NOT_ON_SESSION_BOARD`），工具清单也不
 * 列。浏览器动词整组不列——会话板上建不出浏览器节点。
 *
 * 不带任何 import：`armadra-hook` 的客户端打包也读它。
 */
export const SESSION_BOARD_HIDDEN_VERBS = [
  "sticky",
  "open-browser",
  "open-terminal",
  "color",
  "rename",
] as const;

/** core 起进程时注入的环境变量：节点所在板的种类，只在会话板上出现。 */
export const BOARD_KIND_ENV = "ARMADRA_BOARD_KIND";

export function hiddenOnSessionBoard(verb: string): boolean {
  return (SESSION_BOARD_HIDDEN_VERBS as readonly string[]).includes(verb);
}
