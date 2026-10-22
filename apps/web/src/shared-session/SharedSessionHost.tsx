import * as React from "react";

import { LOCAL_SOURCE_ID } from "@/api/source";
import { hostedRelay } from "@/sources/hosted";
import { useCanvasStore } from "@/store/canvas-store";
import { SharedSessionSkeleton } from "./SharedSessionSkeleton";
import { useSessionShareQuery, useSharedSessionView } from "./sessions";

// 终端那一半带着 xterm：和画布上的终端一样懒加载，不进入口。
const SharedSessionPage = React.lazy(() => import("./SharedSessionPage"));

/**
 * 画布那一块里的只读查看页（契约 §79）。浏览器里按会话链接进来的访客没有画布，
 * 也就没有别处可去：没打开工作空间时问一次身份会话，是会话查看者就直接落到第一条
 * 会话，且不给关闭。桌面上由「加入后打开」（`app/joined-source.tsx`）与侧栏打开。
 */
export function SharedSessionHost() {
  const target = useSharedSessionView((state) => state.target);
  const open = useSharedSessionView((state) => state.open);
  const close = useSharedSessionView((state) => state.close);
  const workspace = useCanvasStore((state) => state.workspace);
  const guest = hostedRelay()?.guest() != null;
  const shareQuery = useSessionShareQuery(
    LOCAL_SOURCE_ID,
    guest && workspace === null,
  );
  const share = shareQuery.data;
  const landing = guest && share?.sessionOnly === true;
  const first = landing ? share.sessions[0] : undefined;

  React.useEffect(() => {
    if (first === undefined || target !== null) return;
    open({ sourceId: LOCAL_SOURCE_ID, ...first });
  }, [first, open, target]);

  // 访客落地：还没问出是不是会话查看者时，主区是整页骨架而不是空画布底色。
  if (target === null)
    return guest && workspace === null && shareQuery.isLoading ? (
      <SharedSessionSkeleton />
    ) : null;
  return (
    <React.Suspense fallback={<SharedSessionSkeleton />}>
      <SharedSessionPage
        key={`${target.sourceId}:${target.sessionId}`}
        target={target}
        onClose={landing ? undefined : close}
      />
    </React.Suspense>
  );
}
