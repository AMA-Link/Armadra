import type { BoardDocument, Viewport } from "@armadra/shared";

import { isPhoneScreen } from "@/platform/layout";
import { defaultNodeSize, nodeFontPx } from "@/store/defaults";
import { containerSize } from "./flow/flow-context";
import { phoneOpeningViewport } from "./viewport";

/**
 * 打开画布时要恢复的视口经过这里（#715）：手机上（横竖屏）存的缩放低于字号
 * 下限就换成 `viewport.phoneOpeningViewport` 给的那份，其余原样返回。
 *
 * 两处恢复都走它：存在画布文档里的视口（`flow/use-flow-viewport.
 * applyBoardViewport`），与实时板存在本机的视口（`realtime/session`）。
 */
export function readableOpeningViewport(
  saved: Viewport,
  document: BoardDocument | null | undefined,
): Viewport {
  if (!document || !isPhoneScreen()) return saved;
  return (
    phoneOpeningViewport({
      persisted: saved,
      nodes: document.nodes.map((node) => ({
        x: node.position.x,
        y: node.position.y,
        ...(node.size ?? defaultNodeSize(node.type)),
        parentId: node.parentId ?? null,
        fontPx: nodeFontPx(node.type),
      })),
      container: containerSize(),
    }) ?? saved
  );
}
