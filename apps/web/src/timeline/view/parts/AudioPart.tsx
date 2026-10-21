import * as React from "react";
import { ChevronDown, ChevronRight, Music } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { formatBytes } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { useBlobUrl } from "../services";

export interface AudioPartProps {
  blobId?: string | undefined;
  mimeType: string;
  bytes?: number | undefined;
  dropped?: boolean | undefined;
}

/** 音频：一行附件，展开后才取数据，是原生 `<audio controls>`（设计 §3.1）。 */
export function AudioPart({
  blobId,
  mimeType,
  bytes,
  dropped,
}: AudioPartProps) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const playable = dropped !== true && blobId !== undefined;
  const { url, failed } = useBlobUrl(blobId, open && playable);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="timeline-audio">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={!playable}
            className="font-normal"
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            <Music />
            {t("timeline.audio")}
          </Button>
        </CollapsibleTrigger>
        <Badge variant="outline" className="font-mono">
          {mimeType}
        </Badge>
        {bytes !== undefined && (
          <span className="text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
            {formatBytes(bytes)}
          </span>
        )}
      </div>
      <CollapsibleContent className="pt-1">
        {url !== null ? (
          <audio controls src={url} className="h-8 w-full max-w-sm">
            <track kind="captions" />
          </audio>
        ) : failed ? (
          <span className="text-[length:var(--text-caption)] text-muted-foreground">
            {t("timeline.audio.failed")}
          </span>
        ) : (
          <Spinner aria-hidden className="size-3 text-muted-foreground" />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
