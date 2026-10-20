import type { TimelineAssistantItem, TimelinePart } from "@armadra/shared";

import { ActionBar, CopyAction } from "@/acp/MessageActions";
import { Spinner } from "@/ui/spinner";
import { AudioPart } from "../parts/AudioPart";
import { ImagePart } from "../parts/ImagePart";
import { ResourceLinkPart, ResourcePart } from "../parts/ResourcePart";
import { StreamingMarkdown } from "../parts/StreamingMarkdown";
import { memoRow } from "../row-memo";

export interface AssistantRowProps {
  item: TimelineAssistantItem;
}

function PartView({ part }: { part: TimelinePart }) {
  switch (part.type) {
    case "text":
      return part.text.trim() === "" ? null : (
        <StreamingMarkdown text={part.text} />
      );
    case "image":
      return (
        <ImagePart
          blobId={part.blobId}
          mimeType={part.mimeType}
          dropped={part.dropped}
        />
      );
    case "resource_link":
      return (
        <ResourceLinkPart
          uri={part.uri}
          name={part.name}
          title={part.title}
          mimeType={part.mimeType}
        />
      );
    case "resource":
      return (
        <ResourcePart
          uri={part.uri}
          name={part.name}
          mimeType={part.mimeType}
          text={part.text}
          blobId={part.blobId}
          bytes={part.bytes}
          dropped={part.dropped}
        />
      );
    case "audio":
      return (
        <AudioPart
          blobId={part.blobId}
          mimeType={part.mimeType}
          bytes={part.bytes}
          dropped={part.dropped}
        />
      );
  }
}

/** 助手消息：按部件顺序渲染；文本是流式 Markdown，其余是结构化部件。 */
function AssistantRowImpl({ item }: AssistantRowProps) {
  const text = item.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  const empty = item.parts.every(
    (part) => part.type === "text" && part.text.trim() === "",
  );
  return (
    <div
      data-slot="timeline-assistant"
      data-role="assistant"
      data-streaming={item.streaming || undefined}
      className="group/act relative flex max-w-[72ch] flex-col gap-1.5"
    >
      {item.parts.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
      {item.streaming && empty && (
        <Spinner aria-hidden className="size-3 text-muted-foreground" />
      )}
      {text.trim() !== "" && (
        <ActionBar className="absolute -top-2 right-0 rounded-[var(--r-control)] bg-[var(--card)]">
          <CopyAction text={text} />
        </ActionBar>
      )}
    </div>
  );
}

export const AssistantRow = memoRow(AssistantRowImpl);
