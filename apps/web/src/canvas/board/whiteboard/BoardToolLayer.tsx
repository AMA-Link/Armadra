import * as React from "react";
import { Overlay, useBoard } from "@armadra/board/react";
import type { CanvasNode } from "@armadra/shared";

import { useCanvasReadOnly } from "@/store/canvas/presence";
import { useMermaidDialogOpen } from "../../whiteboard/mermaid/open";
import { useClipboardCommands } from "../../whiteboard/tools/use-clipboard";
import {
  useDefaultStyle,
  useMermaidCommand,
} from "../../whiteboard/tools/use-tool-commands";
import { installWhiteboardInteractions } from "./interactions";
import { ItemSelection } from "./ItemSelection";
import { TextEditor } from "./TextEditor";

const ImportMermaidDialog = React.lazy(
  () => import("../../whiteboard/mermaid/ImportMermaidDialog"),
);

/**
 * `next` 引擎的白板工具层（`whiteboard/tools/ToolLayer` 的对应物）。
 *
 * 命令与偏好推送与旧版共用同一份（剪贴板、Mermaid、默认样式）；选择框与文字编辑
 * 画在引擎的叠加层里；指针交互见 `interactions.ts`。
 */
export function BoardToolLayer() {
  const board = useBoard<CanvasNode>();
  const readOnly = useCanvasReadOnly();
  const latest = React.useRef(readOnly);
  latest.current = readOnly;
  const mermaidOpen = useMermaidDialogOpen();

  useClipboardCommands();
  useDefaultStyle();
  useMermaidCommand();

  React.useEffect(() => {
    const container = board
      .slots()
      ?.screen.closest<HTMLElement>("[data-board-stage]");
    return container
      ? installWhiteboardInteractions(board, container, () => latest.current)
      : undefined;
  }, [board]);

  return (
    <>
      <Overlay>
        <ItemSelection />
        <TextEditor />
      </Overlay>
      {mermaidOpen ? (
        <React.Suspense fallback={null}>
          <ImportMermaidDialog />
        </React.Suspense>
      ) : null}
    </>
  );
}
