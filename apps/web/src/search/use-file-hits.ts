import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "@/api/client";
import { sk } from "@/sources/scope";
import { useCanvasStore } from "@/store/canvas-store";

/** 输入去抖：一次键入不该变成一次全工作区扫描。 */
export const FILE_DEBOUNCE_MS = 150;
/** 文件一组最多列这么多条。 */
export const FILE_LIMIT = 8;

export interface FileHit {
  name: string;
  path: string;
}

/**
 * 当前工作空间里按文件名匹配的文件（与 ⌘P 同一个索引接口、同一份缓存键）。
 * 只在面板开着且有输入时查；多个词只取第一个词去问索引，文件名里很少有空格。
 */
export function useFileHits(open: boolean, query: string): FileHit[] {
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const [term, setTerm] = useState("");
  const wanted = query.trim().split(/\s+/)[0] ?? "";

  useEffect(() => {
    if (!open || wanted === "") {
      setTerm("");
      return;
    }
    const timer = window.setTimeout(() => setTerm(wanted), FILE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, wanted]);

  const index = useQuery({
    queryKey: sk("file-index", workspaceId, term),
    queryFn: () => runtimeApi.fileIndex(workspaceId!, term),
    enabled: open && term !== "" && Boolean(workspaceId),
    retry: false,
  });
  if (!open || term === "" || wanted !== term) return [];
  return (index.data?.entries ?? [])
    .slice(0, FILE_LIMIT)
    .map((entry) => ({ name: entry.name, path: entry.path }));
}
