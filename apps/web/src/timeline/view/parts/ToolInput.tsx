import type { TimelineToolInput } from "@armadra/shared";
import { Globe, Search, SquareTerminal } from "lucide-react";

import { basename } from "@/files/file-operations";

/**
 * 工具入参的结构化摘要（设计 §3.1）：命令、路径与行号、查询、URL 各占一行，
 * 其余标量是 键:值 列表。不贴 JSON 原文。
 */
export function ToolInput({ input }: { input: TimelineToolInput }) {
  const fields = input.fields ?? [];
  const hasAny =
    input.command !== undefined ||
    input.path !== undefined ||
    input.query !== undefined ||
    input.url !== undefined ||
    fields.length > 0;
  if (!hasAny) return null;
  return (
    <div
      data-slot="timeline-tool-input"
      className="flex min-w-0 flex-col gap-0.5 text-xs"
    >
      {input.command !== undefined && (
        <div className="flex min-w-0 items-start gap-1.5 font-mono">
          <SquareTerminal className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words whitespace-pre-wrap">
            {input.command}
          </span>
        </div>
      )}
      {input.path !== undefined && (
        <div className="flex min-w-0 items-center gap-1.5 font-mono">
          <span className="truncate" title={input.path}>
            {basename(input.path) || input.path}
            {input.line !== undefined ? `:${input.line}` : ""}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">
            {input.path}
          </span>
        </div>
      )}
      {input.query !== undefined && (
        <div className="flex min-w-0 items-center gap-1.5">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">{input.query}</span>
        </div>
      )}
      {input.url !== undefined && (
        <div className="flex min-w-0 items-center gap-1.5">
          <Globe className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono">{input.url}</span>
        </div>
      )}
      {fields.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5">
          {fields.map((field, index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{field.key}</dt>
              <dd className="min-w-0 font-mono break-words">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
