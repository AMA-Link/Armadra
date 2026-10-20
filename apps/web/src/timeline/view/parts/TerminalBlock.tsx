import * as React from "react";

import { useT } from "@/app/preferences-store";
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
}

/** 工具终端输出（设计 §3.1）：命令行、退出码、输出尾部；SGR 16 / 256 色。 */
export function TerminalBlock({
  command,
  output,
  exitCode,
  truncated,
  originalBytes,
  running,
}: TerminalBlockProps) {
  const t = useT();
  const spans = React.useMemo(() => parseAnsi(output ?? ""), [output]);
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (running) end.current?.scrollIntoView?.({ block: "nearest" });
  }, [running, output]);
  const failed = typeof exitCode === "number" && exitCode !== 0;
  return (
    <div
      data-slot="timeline-terminal"
      className="overflow-hidden rounded-[var(--r-control)] bg-[var(--surface-sunken)]"
    >
      {(command !== undefined || exitCode !== undefined) && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1 font-mono text-xs">
          <span className="text-muted-foreground">$</span>
          <span className="min-w-0 flex-1 truncate" title={command}>
            {command}
          </span>
          {typeof exitCode === "number" && (
            <Badge
              variant={failed ? "destructive" : "outline"}
              data-slot="timeline-exit"
              className="shrink-0 tabular-nums"
            >
              {t("timeline.terminal.exit", { code: exitCode })}
            </Badge>
          )}
        </div>
      )}
      {truncated && (
        <div className="px-2 pt-1 text-[length:var(--text-caption)] text-muted-foreground">
          {originalBytes !== undefined
            ? t("timeline.truncated.of", { size: formatBytes(originalBytes) })
            : t("timeline.truncated")}
        </div>
      )}
      {(output ?? "") !== "" && (
        <ScrollArea className="max-h-64">
          <pre className="px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap">
            {spans.map((span, index) => (
              <span
                key={index}
                style={{
                  color: span.fg,
                  backgroundColor: span.bg,
                  fontWeight: span.bold ? 600 : undefined,
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
    </div>
  );
}
