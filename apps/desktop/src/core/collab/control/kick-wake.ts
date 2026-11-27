import type { CollabContext } from "../service";

/**
 * 投递遇到没有会话的目标：踢一下唤醒，不等（契约 §129.5）。
 *
 * 休眠着的接回；core 重启或适配器自己退出而断掉的 ACP 会话接上下一代。接得回来的
 * 那一类在调用的这一拍里就被占住（`sleeping` 为真），门链随即把这一条当「还早」
 * 排队。目标已经在休眠或接回途中就不再踢。
 *
 * 接回结束后再推一下出队泵：接回途中到的状态帧撞上「还在起」又把它排了回去，
 * 此后目标那一侧不会再有事件，排着的那条只能等到过期（#1077）。
 */
export function kickWake(context: CollabContext, nodeId: string): void {
  const terminals = context.terminals;
  if (terminals?.sleeping?.(nodeId) === true) return;
  const woke = terminals?.wakeNode?.(nodeId);
  if (woke === undefined) return;
  void woke.then(
    (ok) => {
      if (ok) setTimeout(() => context.nudge?.(nodeId), 0);
    },
    () => {
      // 接不回来：唤醒方记日志；排着的那条由 TTL 决定死期。
    },
  );
}
