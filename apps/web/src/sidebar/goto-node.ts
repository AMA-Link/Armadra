/**
 * 「跳到某个节点」——可能跨画布（§27）。
 *
 * 同一块板上这件事只有一步：选中 + 发居中事件（居中的算术在画布那边，§9.1）。
 * 跨板要多等两拍：先切板，等 `use-board-sync` 把那块板的文档取回来，
 * 再等画布把文档同步成 shape——`centerOnNode` 读的是 shape 的包围盒，
 * shape 还没落地时它什么也不做。
 *
 * 所以这里的做法是：订阅 store 等文档到位，然后发**一次**居中请求。
 * 「量不到就再等」「后来的视口恢复不许顶掉它」「新请求取代旧请求」都归画布
 * 那边的相机意图（`canvas/flow/camera-intent.ts`，#1028）；这里不留任何
 * 计时器，所以画布卸载之后也不会有迟到的居中（#1007）。
 */
import { requestCenterOnNode } from "../canvas/flow/flow-context";
import { toItemId } from "../canvas/whiteboard/model";
import { useCanvasStore } from "../store/canvas-store";

/** 等文档的上限：超过就放弃订阅，不留着一个永远不触发的监听。 */
export const GOTO_TIMEOUT_MS = 10_000;

function focusNow(nodeId: string): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  recenter(nodeId);
}

/** 白板对象（`wb:` id）：选中它、清掉节点选区，再居中。 */
function focusItemNow(itemId: string): void {
  useCanvasStore
    .getState()
    .setSelection({ nodes: [], edges: [], items: [itemId] });
  recenter(itemId);
}

function recenter(id: string): void {
  requestCenterOnNode(id);
}

/** 还在等文档的那一次跳转；新的跳转来了就取消它（连点两行以最后一行为准）。 */
let cancelPending: (() => void) | null = null;

/**
 * 需要时先切板，等 `ready` 为真（目标已经在那块板的文档里）再 `focus`。
 * 订阅有上限：超过 `GOTO_TIMEOUT_MS` 放弃，不留着一个永远不触发的监听。
 */
function gotoWhen(
  boardId: string,
  ready: (state: ReturnType<typeof useCanvasStore.getState>) => boolean,
  focus: () => void,
): void {
  cancelPending?.();
  cancelPending = null;
  const state = useCanvasStore.getState();
  if (state.document?.board.id === boardId && ready(state)) {
    focus();
    return;
  }

  state.selectBoard(boardId);

  let unsubscribe: (() => void) | null = null;
  const stop = () => {
    clearTimeout(timer);
    unsubscribe?.();
    unsubscribe = null;
    if (cancelPending === stop) cancelPending = null;
  };
  const timer = setTimeout(stop, GOTO_TIMEOUT_MS);
  cancelPending = stop;

  unsubscribe = useCanvasStore.subscribe((next) => {
    if (next.document?.board.id !== boardId || !ready(next)) return;
    stop();
    focus();
  });
}

/** 需要时先切板，然后选中并居中到 `nodeId`。 */
export function gotoNode(boardId: string, nodeId: string): void {
  gotoWhen(
    boardId,
    (state) =>
      state.document?.nodes.some((node) => node.id === nodeId) ?? false,
    () => focusNow(nodeId),
  );
}

/** 需要时先切板，然后选中并居中到白板对象 `itemId`（`wb:` 前缀的 id）。 */
export function gotoItem(boardId: string, itemId: string): void {
  gotoWhen(
    boardId,
    (state) =>
      state.whiteboard.items.some((item) => toItemId(item.id) === itemId),
    () => focusItemNow(itemId),
  );
}
