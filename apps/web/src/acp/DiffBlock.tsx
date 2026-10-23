import * as React from "react";
import { FilePlus2 } from "lucide-react";
import type { ContentSource } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { openFileInEditor } from "@/files/open-editor";
import { unifiedLineDiff } from "@/lib/line-diff";
import { PatchBody } from "@/nodes/DiffNode";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { exportDiff } from "./export-to-board";
import { Action, ActionBar, CopyAction } from "./MessageActions";

/** 补丁超过这么多行先折起来，只画前 {@link DIFF_PREVIEW_LINES} 行。 */
export const DIFF_FOLD_LINES = 200;
export const DIFF_PREVIEW_LINES = 60;

/**
 * 工具调用里的文件差异（ACP 设计 §6）：只渲染 ACP 给的 `oldText / newText`，
 * 不去读磁盘；行着色复用变更节点的 `PatchBody`。
 *
 * ACP 的路径是绝对路径，编辑器节点认的是工作区相对路径：不在工作区里的文件
 * 没有「打开」与「落为变更节点」，路径照样能复制。远端执行主机上的工作区根
 * 是那台机器的路径，这条规则不变（ACP 会话视图 §5.4）。
 */
export function workspaceRelative(
  path: string,
  root: string | undefined,
): string | null {
  if (!root) return null;
  const base = root.replace(/[\\/]+$/, "");
  if (path === base) return null;
  for (const separator of ["/", "\\"]) {
    if (path.startsWith(base + separator))
      return path.slice(base.length + 1).replace(/\\/g, "/");
  }
  return null;
}

/** 补丁里的新增 / 删除行数（`+` / `-` 开头的行）。 */
export function patchStat(patch: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** 一处改动的 `+N −M`（`oldText` 为空就是新文件）。 */
export function diffStat(
  oldText: string,
  newText: string,
): { additions: number; deletions: number } {
  return patchStat(unifiedLineDiff(oldText, newText));
}

/**
 * `+N −M`：等宽数字，新增走 `--success-text`、删除走 `--danger-text`（设计系统 §5.1）。
 * 工具行、权限卡「将发生」与差异块头共用这一处写法；两个数都是 0 时不画。
 */
export function DiffCounts({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      data-slot="diff-counts"
      data-numeric
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-caption",
        className,
      )}
    >
      <span className="text-success-text">+{additions}</span>
      <span className="text-danger-text">−{deletions}</span>
    </span>
  );
}

export function DiffBlock({
  path,
  oldText,
  newText,
  source,
}: {
  path: string;
  oldText: string;
  newText: string;
  /** 给了才有「落为变更节点」（连回这个 Agent 节点）。 */
  source?: ContentSource | undefined;
}) {
  const t = useT();
  const root = useCanvasStore((state) => state.workspace?.rootPath);
  const relative = workspaceRelative(path, root);
  const [all, setAll] = React.useState(false);
  const patch = React.useMemo(
    () => unifiedLineDiff(oldText, newText),
    [oldText, newText],
  );
  const { additions, deletions } = React.useMemo(
    () => patchStat(patch),
    [patch],
  );
  const lines = React.useMemo(() => patch.split("\n"), [patch]);
  const folded = !all && lines.length > DIFF_FOLD_LINES;
  const shown = folded ? lines.slice(0, DIFF_PREVIEW_LINES).join("\n") : patch;

  return (
    <Card className="gap-0 overflow-hidden py-0" data-slot="acp-diff">
      <div className="group/act flex items-center gap-2 border-b border-border px-2 py-1">
        <span
          className="min-w-0 flex-1 truncate font-mono text-caption"
          title={path}
        >
          {relative ?? path}
        </span>
        <DiffCounts additions={additions} deletions={deletions} />
        <ActionBar>
          <CopyAction text={patch} label={t("acp.diff.copy")} />
          <CopyAction text={path} label={t("acp.diff.copyPath")} />
          {relative && source && (
            <Action
              label={t("acp.diff.toNode")}
              onClick={() => exportDiff(relative, source)}
            >
              <FilePlus2 />
            </Action>
          )}
        </ActionBar>
        {relative && (
          <Button
            variant="ghost"
            size="xs"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => openFileInEditor(relative)}
          >
            {t("acp.diff.open")}
          </Button>
        )}
      </div>
      <div className="bg-sunken py-1">
        <PatchBody patch={shown} />
      </div>
      {folded && (
        <Button
          variant="ghost"
          size="xs"
          className="m-1 self-start"
          onClick={() => setAll(true)}
        >
          {t("acp.tool.showAll")}
        </Button>
      )}
    </Card>
  );
}
