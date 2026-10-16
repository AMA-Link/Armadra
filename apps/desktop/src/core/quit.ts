/**
 * 退出时要不要把会话一起结束。
 *
 * core 收到 SIGTERM 的缺省是**留着**：服务器壳被服务管理器重启、系统关机、应用内
 * 更新、崩溃恢复，都靠 tmux 里的会话在 core 重启之后接回（`restart.survives`）。
 * 只有用户明确退出桌面应用时，壳才在 SIGTERM 之前经 fork 的 IPC 通道发一条
 * `armadra:quit`，core 据此把会话（tmux server、Windows 会话宿主里的会话）一并
 * 结束。运维与探针也可以用环境变量 `ARMADRA_REAP_ON_STOP=1` 让任意方式的停止都
 * 清干净。
 */
export const QUIT_MESSAGE = "armadra:quit";
export const REAP_ON_STOP_ENV = "ARMADRA_REAP_ON_STOP";

export interface QuitMessage {
  readonly type: typeof QUIT_MESSAGE;
  readonly reapSessions: boolean;
}

/** 这一次停止要做的事；域的收尾回调收到它。 */
export interface StopReason {
  readonly reapSessions: boolean;
}

export function isQuitMessage(message: unknown): message is QuitMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === QUIT_MESSAGE &&
    typeof (message as { reapSessions?: unknown }).reapSessions === "boolean"
  );
}

/** 壳那一头：向 fork 出的 core 发退出意图。通道已断就算了，照旧靠信号停。 */
export function sendQuitIntent(
  child: { send?: (message: QuitMessage) => boolean; connected?: boolean },
  reapSessions: boolean,
): void {
  if (child.send === undefined || child.connected === false) return;
  try {
    child.send({ type: QUIT_MESSAGE, reapSessions });
  } catch {
    // core 已经不在了：没有人收这条消息。
  }
}
