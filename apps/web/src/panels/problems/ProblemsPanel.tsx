import * as React from "react";
import { X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  countDiagnostics,
  groupDiagnostics,
  severityOf,
  useDiagnosticsStore,
  type Diagnostic,
} from "@/editor/language/diagnostics-store";
import { pathOfUri } from "@/editor/language/uri";
import { openFileInEditor } from "@/files/open-editor";
import { useCanvasStore } from "@/store/canvas-store";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { EmptyState } from "@/ui/state";
import { StatusDot } from "@/ui/status-pill";
import { WorkPanelSheet } from "../WorkPanelSheet";
import { Button } from "@/ui/button";

/**
 * 问题面板（语言服务设计 §1.1「诊断」、§4.2）。
 *
 * 按文件分组、点一条打开并定位。它看的是 `diagnostics-store`，而不是某个
 * 编辑器视图的 lint 状态——server 会为整个项目报诊断，其中大部分文件此刻
 * 并没有打开，只看视图就只能看到已经在眼前的那些问题。
 */
export function ProblemsPanel() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.problems);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const byUri = useDiagnosticsStore((state) => state.byUri);

  const groups = React.useMemo(() => groupDiagnostics(byUri), [byUri]);
  const counts = React.useMemo(() => countDiagnostics(byUri), [byUri]);

  return (
    <WorkPanelSheet
      panel="problems"
      open={mode === "drawer"}
      onClose={() => setPanel("problems", "closed")}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="flex-1 truncate text-body font-semibold">
          {t("problems.title")}
        </SheetTitle>
        <span className="text-caption text-muted-foreground">
          {t("problems.summary", {
            errors: String(counts.errors),
            warnings: String(counts.warnings),
          })}
        </span>
        <IconButton
          label={t("problems.close")}
          onClick={() => setPanel("problems", "closed")}
        >
          <X />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-(--space-block) p-(--space-page)">
          {groups.length === 0 && <EmptyState title={t("problems.empty")} />}
          {groups.map((group) => {
            const path = pathOfUri(group.uri);
            return (
              <div
                key={group.uri}
                className="flex min-w-0 flex-col gap-(--space-group)"
              >
                <p className="truncate text-meta font-medium">
                  {path ?? group.uri}
                </p>
                <ul className="flex flex-col">
                  {group.diagnostics.map((diagnostic, index) => (
                    <DiagnosticRow
                      key={`${diagnostic.range.start.line}:${diagnostic.range.start.character}:${index}`}
                      diagnostic={diagnostic}
                      path={path}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </WorkPanelSheet>
  );
}

const SEVERITY_TONE = {
  error: "failed",
  warning: "attention",
  info: "unread",
  hint: "idle",
} as const;

function DiagnosticRow({
  diagnostic,
  path,
}: {
  diagnostic: Diagnostic;
  path: string | null;
}) {
  const t = useT();
  const severity = severityOf(diagnostic);
  // LSP 的行号从 0 起，编辑器的定位接口从 1 起。
  const line = diagnostic.range.start.line + 1;
  return (
    <li>
      <Button
        variant="ghost"
        size="xs"
        type="button"
        disabled={!path}
        className="flex h-auto w-full justify-start font-normal min-w-0 items-start gap-2 rounded-tight px-1 py-1 text-left hover:bg-hover disabled:cursor-default disabled:opacity-100 disabled:hover:bg-transparent"
        onClick={() => {
          if (path) openFileInEditor(path, { line });
        }}
      >
        <StatusDot tone={SEVERITY_TONE[severity]} size={6} className="mt-1.5" />
        <span className="min-w-0 flex-1 text-meta">
          <span className="break-words">{diagnostic.message}</span>
          <span className="pl-2 text-muted-foreground">
            {t("problems.at", { line: String(line) })}
            {diagnostic.source ? ` · ${diagnostic.source}` : ""}
            {diagnostic.code !== undefined ? ` · ${diagnostic.code}` : ""}
          </span>
        </span>
      </Button>
    </li>
  );
}
