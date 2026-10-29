import * as React from "react";

import {
  clearJoinOpen,
  onJoinIntent,
  pendingJoinOpen,
  pendingWorkspaceOpen,
} from "../sources/join-intent";
import {
  useSessionShare,
  useSharedSessionView,
} from "../shared-session/sessions";
import { useCanvasStore } from "../store/canvas-store";
import { useOpenWorkspace } from "./workspace-actions";
import { useWorkspaces } from "./workspaces-query";

/** 等那个源连上、列出工作空间的上限；过了就不再自动打开。 */
const GIVE_UP_MS = 60_000;

/**
 * 按分享链接加入之后、或「在新窗口打开」一个源时，打开那个源的工作空间
 * （客户端包 §6：从链接到画布可见）。会话分享的访客没有工作空间，身份会话报出
 * 会话范围时改开那条会话的只读查看页（契约 §79）。
 * 只在有一项待办时挂上 {@link OpenJoined}，平时不多发查询。
 */
export function JoinedSourceOpener() {
  const [target, setTarget] = React.useState(pendingJoinOpen);
  React.useEffect(() => onJoinIntent(() => setTarget(pendingJoinOpen())), []);
  const done = React.useCallback(() => {
    clearJoinOpen();
    setTarget(null);
  }, []);
  if (target === null) return null;
  return <OpenJoined sourceId={target} onDone={done} />;
}

function OpenJoined({
  sourceId,
  onDone,
}: {
  sourceId: string;
  onDone(): void;
}) {
  const workspaces = useWorkspaces();
  const openWorkspace = useOpenWorkspace();
  const [wanted] = React.useState(pendingWorkspaceOpen);
  const found =
    (wanted === null
      ? undefined
      : workspaces.data.find(
          (one) => one.sourceId === sourceId && one.workspace.id === wanted,
        )) ?? workspaces.data.find((one) => one.sourceId === sourceId);
  const share = useSessionShare(sourceId);
  const openShared = useSharedSessionView((state) => state.open);
  const shared = share?.sessionOnly === true ? share.sessions[0] : undefined;

  React.useEffect(() => {
    const timer = setTimeout(onDone, GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  React.useEffect(() => {
    if (found === undefined) return;
    onDone();
    // 当前源跟着打开的工作空间换过去（`sources/follow-workspace.ts`）。
    openWorkspace(found.workspace as never, sourceId);
    useCanvasStore.getState().setPanel("settings", false);
  }, [found, onDone, openWorkspace, sourceId]);

  React.useEffect(() => {
    if (found !== undefined || shared === undefined) return;
    onDone();
    openShared({ sourceId, ...shared });
    useCanvasStore.getState().setPanel("settings", false);
  }, [found, onDone, openShared, shared, sourceId]);

  return null;
}
