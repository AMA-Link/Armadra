import * as React from "react";

import { SessionSkeleton } from "@/acp/SessionSkeleton";
import { useCanvasStore } from "@/store/canvas-store";
import { useSessionPage } from "./store";

const SessionPage = React.lazy(() => import("./SessionPage"));

/** Escape 该不该归别人：弹层自己处理过的、正在写字的框里还有字的，都不关页面。 */
function escapeBelongsToPage(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (
    target.closest("[role=dialog],[role=menu],[role=listbox],[role=combobox]")
  )
    return false;
  if (
    (target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement) &&
    target.value !== ""
  )
    return false;
  return true;
}

/**
 * 盖住画布那一块的会话页（Armadra#1062）。画布仍然挂着——它的文档、选区与视口
 * 都不动，关掉页面就回到原处。入口是右上工具簇与命令 `app.sessions`。
 */
export function SessionPageHost() {
  const open = useSessionPage((state) => state.open);
  const close = useSessionPage((state) => state.close);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (escapeBelongsToPage(event)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // 换工作空间：会话属于上一个工作空间，页面关掉、选中与新开的清空。
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const previous = React.useRef(workspaceId);
  React.useEffect(() => {
    if (previous.current === workspaceId) return;
    previous.current = workspaceId;
    useSessionPage.setState({
      open: false,
      selectedNodeId: null,
      starting: [],
    });
  }, [workspaceId]);

  if (!open) return null;
  return (
    <React.Suspense fallback={<SessionSkeleton />}>
      <SessionPage />
    </React.Suspense>
  );
}
