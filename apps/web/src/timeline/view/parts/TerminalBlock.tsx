import * as React from "react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { ScrollArea } from "@/ui/scroll-area";
import { parseAnsi } from "../ansi";

export interface TerminalBlockProps {
  command?: string | undefined;
  output?: string | undefined;
  exitCode?: number | null | undefined;
  truncated?: boolean | undefined;
  originalBytes?: number | undefined;
  /** 工具还在跑：输出实时追加，视图跟到末尾。 */
  running?: boolean | undefined;
  /** 命令行右侧画不画退出码（工具卡片的标题行已经画了就不画）。 */
  showExit?: boolean | undefined;
}

/**
 * 工具终端输出（设计 §3.1）：完整的命令行（可换行）、退出码、输出尾部；SGR 16 /
 * 256 色。结束了还没有输出时写「无输出」。
 */
export function TerminalBlock({
  command,
  output,
  exitCode,
  truncated,
  originalBytes,
  running,
  showExit = true,
}: TerminalBlockProps) {
  const t = useT();
  const spans = React.useMemo(() => parseAnsi(output ?? ""), [output]);
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (running) end.current?.scrollIntoView?.({ block: "nearest" });
  }, [running, output]);
  const failed = typeof exitCode === "number" && exitCode !== 0;
  const exit = showExit && typeof exitCode === "number";
  const empty = (output ?? "") === "";
  return (
    <div
      data-slot="timeline-terminal"
      className="overflow-hidden rounded-control bg-sunken"
    >
      {(command !== undefined || exit) && (
        <div
          data-slot="timeline-terminal-command"
          className={cn(
            "flex items-start gap-2 px-2.5 py-1.5 font-mono text-meta",
            !(empty && running) && "border-b border-border",
          )}
        >
          <span aria-hidden className="text-muted-foreground select-none">
            $
          </span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere] whitespace-pre-wrap">
            {command}
          </span>
          {exit && (
            <Badge
              variant={failed ? "destructive" : "outline"}
              data-slot="timeline-exit"
              size="sm"
              className="shrink-0"
            >
              {t("timeline.terminal.exit", { code: exitCode })}
            </Badge>
          )}
        </div>
      )}
      {truncated && (
        <div className="px-2.5 pt-1 text-caption text-muted-foreground">
          {originalBytes !== undefined
            ? t("timeline.truncated.of", { size: formatBytes(originalBytes) })
            : t("timeline.truncated")}
        </div>
      )}
      {(output ?? "") !== "" && (
        <ScrollArea className="max-h-64">
          <pre className="px-2.5 py-1.5 font-mono text-meta [overflow-wrap:anywhere] whitespace-pre-wrap">
            {spans.map((span, index) => (
              <span
                key={index}
                style={{
                  color: span.fg,
                  backgroundColor: span.bg,
                  fontWeight: span.bold ? "var(--fw-semibold)" : undefined,
                  opacity: span.dim ? 0.7 : undefined,
                  fontStyle: span.italic ? "italic" : undefined,
                  textDecoration: span.underline ? "underline" : undefined,
                }}
              >
                {span.text}
              </span>
            ))}
          </pre>
          <div ref={end} />
        </ScrollArea>
      )}
      {empty && !running && (
        <div
          data-slot="timeline-terminal-empty"
          className="px-2.5 py-1.5 text-caption text-muted-foreground"
        >
          {t("timeline.terminal.noOutput")}
        </div>
      )}
    </div>
  );
}
