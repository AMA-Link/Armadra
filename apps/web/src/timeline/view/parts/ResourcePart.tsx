import * as React from "react";
import {
  Download,
  ExternalLink,
  File,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  type LucideIcon,
} from "lucide-react";

import { useT } from "@/app/preferences-store";
import { formatBytes } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/ui/item";
import { basename } from "@/files/file-operations";
import { useTimelineServices } from "../services";
import { CodeBlock } from "./CodeBlock";

export function iconForMime(mimeType: string | undefined): LucideIcon {
  if (mimeType === undefined) return File;
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("text/") || mimeType.includes("json"))
    return FileText;
  return File;
}

const ITEM_CLASS = "px-2 py-1";

export interface ResourceLinkProps {
  uri: string;
  name?: string | undefined;
  title?: string | undefined;
  mimeType?: string | undefined;
}

/** 资源链接：一行，按 MIME 选图标，名称，打开（设计 §3.1）。 */
export function ResourceLinkPart({
  uri,
  name,
  title,
  mimeType,
}: ResourceLinkProps) {
  const t = useT();
  const { openUri } = useTimelineServices();
  const Icon = iconForMime(mimeType);
  const label = title ?? (name || basename(uri) || uri);
  return (
    <Item
      variant="outline"
      size="xs"
      className={ITEM_CLASS}
      data-slot="timeline-resource-link"
    >
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="max-w-full truncate" title={uri}>
          {label}
        </ItemTitle>
      </ItemContent>
      {mimeType !== undefined && (
        <Badge variant="outline" className="shrink-0 font-mono">
          {mimeType}
        </Badge>
      )}
      {openUri !== undefined && (
        <ItemActions>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t("timeline.resource.open")}
            onClick={() => openUri(uri)}
          >
            <ExternalLink />
          </Button>
        </ItemActions>
      )}
    </Item>
  );
}

export interface ResourceBodyProps extends ResourceLinkProps {
  text?: string | undefined;
  blobId?: string | undefined;
  bytes?: number | undefined;
  dropped?: boolean | undefined;
  truncated?: boolean | undefined;
}

/**
 * 内嵌资源：有文本是可折叠的代码块，标题是文件名；只有 blob 的与资源链接同形，
 * 可下载。
 */
export function ResourcePart(props: ResourceBodyProps) {
  const t = useT();
  const { loadBlob } = useTimelineServices();
  const { text, blobId, bytes, dropped, uri, name, mimeType } = props;
  const [open, setOpen] = React.useState(false);
  const label = name || basename(uri) || uri;
  const Icon = iconForMime(mimeType);

  if (text === undefined) {
    const download = async (): Promise<void> => {
      if (blobId === undefined || loadBlob === undefined) return;
      const blob = await loadBlob(blobId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = label;
      anchor.click();
      URL.revokeObjectURL(url);
    };
    return (
      <Item
        variant="outline"
        size="xs"
        className={ITEM_CLASS}
        data-slot="timeline-resource"
      >
        <ItemMedia variant="icon">
          <Icon />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="max-w-full truncate" title={uri}>
            {label}
          </ItemTitle>
        </ItemContent>
        {bytes !== undefined && (
          <Badge variant="outline" className="shrink-0 tabular-nums">
            {formatBytes(bytes)}
          </Badge>
        )}
        {dropped !== true && blobId !== undefined && loadBlob !== undefined && (
          <ItemActions>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t("timeline.resource.download")}
              onClick={() => void download()}
            >
              <Download />
            </Button>
          </ItemActions>
        )}
      </Item>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="timeline-resource"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="max-w-full font-mono font-normal"
          title={uri}
        >
          <Icon />
          <span className="truncate">{label}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        <CodeBlock>{text}</CodeBlock>
      </CollapsibleContent>
    </Collapsible>
  );
}
