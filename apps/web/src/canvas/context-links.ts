import * as React from "react";
import { toast } from "@/ui/toast";
import { t } from "@/app/preferences-store";
import {
  mergeLinkDocument,
  sameLinkDocument,
  type BoardDocument,
  type ContextLink,
} from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { useContentLinks, type ContentLinkMap } from "./content-links";

/**
 * 把白板内容链接推给 Runtime（§6.3，Armadra#1062 S1）。
 *
 * 链接文档的**节点**那一半由 core 在每次写板时按连线编译，画布不再推；这里
 * 只推白板对象那一半（`kind: "shape"`）——它带着只有页面画得出的 PNG。core
 * 把两半并成一份，节点链接在前。
 *
 * 只有终端节点有文档；没有内容链接的终端也推一次空数组，图形被摘掉时 Runtime
 * 那边的旧内容链接才会清掉。
 */

/** 一次改动后等这么久再推：连着改几笔只推最后一次。 */
export const PUBLISH_DELAY_MS = 400;

export interface LinkDocuments {
  [nodeId: string]: ContextLink[];
}

/**
 * 每个终端节点 → 它的内容链接（按来源对象去重，截到 64 条）。
 *
 * `content` 是 `useContentLinks()` 的结果；白板对象不在 `BoardDocument` 里，
 * 所以由它收集后传进来。
 */
export function buildContentDocuments(
  document: Pick<BoardDocument, "nodes">,
  content: ContentLinkMap = {},
): LinkDocuments {
  const documents: LinkDocuments = {};
  for (const node of document.nodes) {
    if (node.type !== "terminal") continue;
    documents[node.id] = mergeLinkDocument<ContextLink>(
      [],
      content[node.id] ?? [],
    );
  }
  return documents;
}

/** 两份文档是否一致（顺序也算：Runtime 存的是数组）。 */
export function sameLinks(
  a: readonly ContextLink[] | undefined,
  b: readonly ContextLink[],
): boolean {
  return sameLinkDocument(a, b);
}

/**
 * 与上次推送比对，返回这次需要重推的节点。节点整个不在了则不推——它的文档
 * 随节点一起由 core 删掉。
 */
export function changedDocuments(
  previous: LinkDocuments,
  next: LinkDocuments,
): string[] {
  const changed: string[] = [];
  for (const [nodeId, links] of Object.entries(next)) {
    if (!sameLinks(previous[nodeId], links)) changed.push(nodeId);
  }
  return changed;
}

/** 画布挂一次；内容链接变化时增量推送。 */
export function usePublishContentLinks(): void {
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const board = useCanvasStore((state) => state.document?.board.id);
  const content = useContentLinks();
  const latest = React.useRef<LinkDocuments>({});
  const kick = React.useRef<(() => void) | null>(null);

  // 节点**不走 React 订阅**：这个 hook 住在画布根组件里，订 `nodes` 等于每次
  // 节点数据变动（一次会话状态跳动、一步拖动）都让整块画布重渲，而这里只需要
  // 在终端节点增删时重算一份文档。
  React.useEffect(() => {
    let nodes: unknown;
    const refresh = () => {
      const document = useCanvasStore.getState().document;
      nodes = document?.nodes;
      latest.current = document ? buildContentDocuments(document, content) : {};
      kick.current?.();
    };
    refresh();
    return useCanvasStore.subscribe((state) => {
      if (state.document?.nodes === nodes) return;
      refresh();
    });
  }, [content, board, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId || !board) return;
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    const toastId = `reference-publish-${workspaceId}-${board}`;
    const published: LinkDocuments = {};
    const schedule = (delay = PUBLISH_DELAY_MS) => {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
    };
    const flush = async () => {
      if (disposed || running) return;
      running = true;
      const wanted = latest.current;
      let failed = false;
      try {
        for (const nodeId of changedDocuments(published, wanted)) {
          const links = wanted[nodeId] ?? [];
          try {
            await runtimeApi.putContentLinks(workspaceId, nodeId, links);
            if (disposed) return;
            // Record only confirmed writes. One request at a time prevents an
            // old slow PUT from overwriting a newer link document.
            published[nodeId] = links;
          } catch {
            failed = true;
          }
          if (disposed) return;
        }
      } finally {
        running = false;
        if (!disposed) {
          if (failed) {
            if (retries < 3) {
              retries += 1;
              schedule(1000 * 2 ** retries);
            } else
              toast.error(t("shape.referenceSyncFailed"), {
                id: toastId,
                action: {
                  label: t("shape.refreshReference"),
                  onClick: request,
                },
              });
          } else {
            toast.dismiss(toastId);
            if (changedDocuments(published, latest.current).length > 0)
              schedule();
          }
        }
      }
    };
    const request = () => {
      retries = 0;
      schedule();
    };
    kick.current = request;
    window.addEventListener("online", request);
    window.addEventListener("armadra:refresh-content-references", request);
    request();
    return () => {
      disposed = true;
      kick.current = null;
      toast.dismiss(toastId);
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("online", request);
      window.removeEventListener("armadra:refresh-content-references", request);
    };
  }, [board, workspaceId]);
}
