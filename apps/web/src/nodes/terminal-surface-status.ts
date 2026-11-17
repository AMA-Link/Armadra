import type { TerminalRenderState } from "@/terminal/render-state";
import type { TerminalSurfaceStatus } from "@/terminal/surface/types";

/**
 * 节点头只区分「休眠」「断开」与其余：`visible` / `offscreen` / `focused` /
 * `detached` 之间的切换由视口与渲染名额驱动，平移时一次换五个终端，整个节点
 * 跟着重渲是白费（一次约 300 个组件，正好压出一帧 34 ms）。
 */
function headRender(render: TerminalRenderState): string {
  return render === "hibernated" || render === "disconnected" ? render : "live";
}

/** 表面上报的状态对节点头没有可见差别时保留旧对象，`setState` 就不重渲。 */
export function nextSurfaceStatus(
  current: TerminalSurfaceStatus,
  next: TerminalSurfaceStatus,
): TerminalSurfaceStatus {
  return current.connection === next.connection &&
    current.exitCode === next.exitCode &&
    current.error === next.error &&
    current.binding?.sessionId === next.binding?.sessionId &&
    current.binding?.generation === next.binding?.generation &&
    (current.binding == null) === (next.binding == null) &&
    current.hibernation === next.hibernation &&
    current.launch === next.launch &&
    headRender(current.render) === headRender(next.render)
    ? current
    : next;
}
