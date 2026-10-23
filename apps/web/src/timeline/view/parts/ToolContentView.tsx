import type { TimelineToolContent } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { DiffBlock, DiffCounts } from "@/acp/DiffBlock";
import { formatBytes } from "@/lib/format";
import { useTimelineServices } from "../services";
import { CodeBlock } from "./CodeBlock";
import { ImagePart } from "./ImagePart";
import { ResourcePart } from "./ResourcePart";
import { TerminalBlock } from "./TerminalBlock";

/**
 * 工具输出的一个部件。文本是代码块；diff 复用 `DiffBlock`（超限的 diff 只剩
 * 路径与行数）；终端输出是 `TerminalBlock`；图片、资源同助手消息。没有任何
 * 一类退回原始 JSON。
 */
export function ToolContentView({
  content,
  running,
}: {
  content: TimelineToolContent;
  running: boolean;
}) {
  const t = useT();
  const { source } = useTimelineServices();
  switch (content.type) {
    case "text":
      return (
        <div className="flex flex-col gap-0.5">
          {content.truncated && (
            <span className="text-caption text-muted-foreground">
              {content.originalBytes !== undefined
                ? t("timeline.truncated.of", {
                    size: formatBytes(content.originalBytes),
                  })
                : t("timeline.truncated")}
            </span>
          )}
          <CodeBlock className="whitespace-pre-wrap">{content.text}</CodeBlock>
        </div>
      );
    case "diff":
      if (content.truncated) {
        return (
          <div
            data-slot="timeline-diff-summary"
            className="flex items-center gap-2 font-mono text-meta"
          >
            <span className="min-w-0 truncate" title={content.path}>
              {content.path}
            </span>
            <DiffCounts
              additions={content.addedLines ?? 0}
              deletions={content.removedLines ?? 0}
            />
          </div>
        );
      }
      return (
        <DiffBlock
          path={content.path}
          oldText={content.oldText ?? ""}
          newText={content.newText ?? ""}
          source={source}
        />
      );
    case "terminal":
      return (
        <TerminalBlock
          command={content.command}
          output={content.output}
          exitCode={content.exitCode}
          truncated={content.truncated}
          originalBytes={content.originalBytes}
          running={running}
        />
      );
    case "image":
      return (
        <ImagePart
          blobId={content.blobId}
          mimeType={content.mimeType}
          dropped={content.dropped}
        />
      );
    case "resource":
      return (
        <ResourcePart
          uri={content.uri}
          name={content.name}
          mimeType={content.mimeType}
          text={content.text}
          blobId={content.blobId}
          bytes={content.bytes}
          dropped={content.dropped}
        />
      );
  }
}
