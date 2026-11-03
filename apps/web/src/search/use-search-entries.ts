import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { BoardDocument, WorkspaceSummary } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { useWorkspacesQuery } from "@/app/workspaces-query";
import { parseWhiteboard } from "@/canvas/whiteboard/serialize";
import { displayName } from "@/sidebar/display-name";
import { sk } from "@/sources/scope";
import { useCanvasStore } from "@/store/canvas-store";
import {
  boardEntries,
  documentEntries,
  workspaceEntries,
  type SearchEntry,
} from "./index";

/**
 * 一次最多去取这么多块别的画布的文档。每块一个请求：超过的部分只能按画布名
 * 找到，里面的节点与白板内容搜不到（按最近打开的工作空间优先）。
 */
export const MAX_FETCHED_BOARDS = 40;

/** 取回来的文档不常变：30 秒内当作新鲜（与 `use-board-sync` 的失效并存）。 */
const DOCUMENT_STALE_MS = 30_000;

interface BoardRef {
  workspaceId: string;
  boardId: string;
}

/**
 * 取回来的文档（react-query 保证同一份数据是同一个对象）→ 条目。按文档对象缓存，
 * 面板每次输入重算时不必重新解析白板；名字变了（改名、换语言）键就不同，重建。
 */
const documentCache = new WeakMap<
  BoardDocument,
  { key: string; entries: SearchEntry[] }
>();

function entriesOfDocument(
  document: BoardDocument,
  workspace: { id: string; name: string },
  boardName: string,
): SearchEntry[] {
  const key = `${workspace.name}\u0000${boardName}`;
  const cached = documentCache.get(document);
  if (cached?.key === key) return cached.entries;
  const entries = documentEntries({
    workspace,
    board: { id: document.board.id, name: boardName },
    nodes: document.nodes,
    whiteboard: parseWhiteboard(document.board.whiteboard).doc,
  });
  documentCache.set(document, { key, entries });
  return entries;
}

/**
 * 全部可搜条目：工作空间、画布，以及各画布里的节点与白板对象。
 *
 * 工作空间与画布名来自工作空间列表（一次请求，侧栏也在用）。当前画布的内容读
 * store（含还没落盘的编辑）；别的画布的内容**只在有输入时**才去取，空查询时
 * 面板只列画布与当前画布，不发请求。
 */
export function useSearchEntries(open: boolean, query: string) {
  const t = useT();
  const summaries = useWorkspacesQuery().data;
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const whiteboard = useCanvasStore((state) => state.whiteboard);
  const searching = open && query.trim() !== "";

  /** 当前工作空间在前，其余按最近打开；当前工作空间的画布列表以 store 为准。 */
  const spaces = useMemo(() => {
    const list: {
      id: string;
      name: string;
      boards: { id: string; name: string }[];
    }[] = [];
    const known = [...(summaries ?? [])].sort((a, b) =>
      a.lastOpenedAt < b.lastOpenedAt ? 1 : -1,
    );
    const current = workspace?.id;
    const toSpace = (item: WorkspaceSummary) => ({
      id: item.id,
      name: displayName(item.name, t),
      boards:
        item.id === current
          ? boards.map((board) => ({
              id: board.id,
              name: displayName(board.name, t),
            }))
          : item.boards.map((board) => ({
              id: board.id,
              name: displayName(board.name, t),
            })),
    });
    const own = known.find((item) => item.id === current);
    if (own) list.push(toSpace(own));
    else if (workspace)
      list.push({
        id: workspace.id,
        name: displayName(workspace.name, t),
        boards: boards.map((board) => ({
          id: board.id,
          name: displayName(board.name, t),
        })),
      });
    for (const item of known) if (item.id !== current) list.push(toSpace(item));
    return list;
  }, [boards, summaries, t, workspace]);

  const refs = useMemo<BoardRef[]>(() => {
    if (!searching) return [];
    const out: BoardRef[] = [];
    for (const space of spaces)
      for (const board of space.boards) {
        if (space.id === workspace?.id && board.id === boardId) continue;
        if (out.length >= MAX_FETCHED_BOARDS) return out;
        out.push({ workspaceId: space.id, boardId: board.id });
      }
    return out;
  }, [boardId, searching, spaces, workspace?.id]);

  const documents = useQueries({
    queries: refs.map((ref) => ({
      queryKey: sk("board", ref.workspaceId, ref.boardId),
      queryFn: () => runtimeApi.loadBoard(ref.workspaceId, ref.boardId),
      staleTime: DOCUMENT_STALE_MS,
      retry: false,
    })),
  });
  // `documents` 每次渲染都是新数组，用各块板数据的更新时间做依赖足够稳。
  const stamp = documents.map((item) => item.dataUpdatedAt).join();

  const entries = useMemo<SearchEntry[]>(() => {
    // 面板关着时不建索引：这个 hook 跟着侧栏常驻，文档每次编辑都会走到这里。
    if (!open) return [];
    const out: SearchEntry[] = [];
    out.push(...workspaceEntries(spaces));
    for (const space of spaces) out.push(...boardEntries(space, space.boards));

    const nameOf = (workspaceId: string, id: string) =>
      spaces
        .find((space) => space.id === workspaceId)
        ?.boards.find((board) => board.id === id)?.name;

    // 当前画布：store 里的文档，含未保存的编辑。
    const space = spaces.find((item) => item.id === workspace?.id);
    if (space && document && document.board.id === boardId) {
      out.push(
        ...documentEntries({
          workspace: space,
          board: {
            id: document.board.id,
            name: nameOf(space.id, document.board.id) ?? document.board.name,
          },
          nodes: document.nodes,
          whiteboard,
        }),
      );
    }
    refs.forEach((ref, index) => {
      const data = documents[index]?.data;
      const owner = spaces.find((item) => item.id === ref.workspaceId);
      if (!data || !owner) return;
      out.push(
        ...entriesOfDocument(
          data,
          owner,
          nameOf(ref.workspaceId, ref.boardId) ?? data.board.name,
        ),
      );
    });
    return out;
    // 依赖 `stamp` 而不是 `documents` 本身，见上。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, document, open, refs, spaces, stamp, whiteboard, workspace?.id]);

  return { entries, workspaces: summaries ?? [] };
}
