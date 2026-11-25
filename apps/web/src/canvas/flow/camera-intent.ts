import { useCanvasStore } from "@/store/canvas-store";

/**
 * 相机意图（#1028）：「居中到某个节点」「把新建的节点送到眼前」这两类请求。
 *
 * 以前它们是「按固定时间表重试几次」，时间表用完就没人保护这次意图，后来的
 * 程序化视口写入（开板的视口恢复、实时板恢复本机视口）会把它覆盖，时延决定成
 * 败，所以偶发。现在每块板同一时刻只有一个意图：
 *
 *  - 新请求取消旧请求（旧目标剩下的重试不会把相机拉回去）；
 *  - 节点量得到尺寸就落地（`attempt` 返回 true），落地后不再重试；
 *  - 落地后（没落地则自请求起一段更长的时间）仍处在**保护期**：此时
 *    {@link cameraIntentHolds} 为真，视口恢复就不写相机；
 *  - 用户自己动了相机（手势、滚轮）、换了板、画布卸载，意图立即作废。
 */

/** 等节点量到尺寸的重试表（毫秒）；落地之后剩下的不再执行。 */
export const CAMERA_INTENT_DELAYS: readonly number[] = [0, 120, 320, 640, 1200];
/** 落地之后的保护期：覆盖「先问 core 再恢复本机视口」那一次往返。 */
export const CAMERA_INTENT_SETTLE_MS = 3000;
/** 一直没落地时，自请求起的保护期上限。 */
export const CAMERA_INTENT_GIVE_UP_MS = 5000;

interface Intent {
  boardId: string | null;
  startedAt: number;
  landedAt: number | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** 保护期内被拦下的视口恢复；意图一直没落地就放弃时补做（#1028）。 */
  restore: (() => void) | null;
}

let current: Intent | null = null;

const openBoardId = (): string | null =>
  useCanvasStore.getState().document?.board.id ?? null;

/** 作废当前意图并清掉它所有的计时器。 */
export function cancelCameraIntent(): void {
  if (!current) return;
  for (const timer of current.timers) clearTimeout(timer);
  current.timers.clear();
  current = null;
}

/**
 * 发起一个相机意图，取代当前的那个。`attempt` 返回 true 表示已经落地
 * （相机已按意图动过）；返回 false 表示还量不到，按时间表再试。
 */
export function startCameraIntent(attempt: () => boolean): void {
  const previous = current;
  const boardId = openBoardId();
  // 同一块板上的新请求接着旧请求被拦下的那份恢复。
  const carried = previous?.boardId === boardId ? previous.restore : null;
  cancelCameraIntent();
  const intent: Intent = {
    boardId,
    startedAt: Date.now(),
    landedAt: null,
    timers: new Set(),
    restore: carried,
  };
  current = intent;

  const run = () => {
    if (current !== intent || intent.landedAt !== null) return;
    if (openBoardId() !== intent.boardId) {
      cancelCameraIntent();
      return;
    }
    if (!attempt()) return;
    intent.landedAt = Date.now();
    for (const timer of intent.timers) clearTimeout(timer);
    intent.timers.clear();
  };

  // 一直量不到就放弃：释放保护，补做被拦下的恢复，别让相机停在上一块板的位置。
  const giveUp = setTimeout(() => {
    if (current !== intent || intent.landedAt !== null) return;
    const restore = intent.restore;
    cancelCameraIntent();
    restore?.();
  }, CAMERA_INTENT_GIVE_UP_MS);
  intent.timers.add(giveUp);

  for (const delay of CAMERA_INTENT_DELAYS) {
    if (delay === 0) {
      run();
      continue;
    }
    if (current !== intent || intent.landedAt !== null) break;
    const timer = setTimeout(() => {
      intent.timers.delete(timer);
      run();
    }, delay);
    intent.timers.add(timer);
  }
}

/**
 * 视口恢复（开板、实时板的本机视口）的入口：当前板上有相机意图在保护期内
 * 就拦下（返回 true，并记下 `restore`，意图一直没落地就放弃时补做），调用方
 * 不动相机；否则返回 false，调用方照常恢复。那份恢复只是「回到上次停的
 * 地方」，不该顶掉用户刚发出的「去那个节点」。
 */
export function holdViewportRestore(restore: () => void): boolean {
  if (!cameraIntentHolds()) return false;
  if (current) current.restore = restore;
  return true;
}

/** 当前板上有没有一个还在保护期内的相机意图。 */
export function cameraIntentHolds(): boolean {
  const intent = current;
  if (!intent) return false;
  if (openBoardId() !== intent.boardId) {
    cancelCameraIntent();
    return false;
  }
  const now = Date.now();
  const until =
    intent.landedAt === null
      ? intent.startedAt + CAMERA_INTENT_GIVE_UP_MS
      : intent.landedAt + CAMERA_INTENT_SETTLE_MS;
  if (now >= until) {
    cancelCameraIntent();
    return false;
  }
  return true;
}
