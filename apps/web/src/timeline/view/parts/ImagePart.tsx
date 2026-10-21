import * as React from "react";
import { ImageOff } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { useBlobUrl } from "../services";

export interface ImagePartProps {
  blobId?: string | undefined;
  mimeType: string;
  dropped?: boolean | undefined;
  /** 附件缩略图用小一号。 */
  compact?: boolean | undefined;
  name?: string | undefined;
}

/** 缩略图，点开大图（设计 §3.1）。数据只有 `blobId`，按需经 `timeline.blob` 取。 */
export function ImagePart({
  blobId,
  mimeType,
  dropped,
  compact,
  name,
}: ImagePartProps) {
  const t = useT();
  const { url, failed } = useBlobUrl(blobId, dropped !== true);
  if (dropped || failed || blobId === undefined) {
    return (
      <Badge variant="outline" data-slot="timeline-image-missing">
        <ImageOff />
        {name ?? t("timeline.image.missing")}
      </Badge>
    );
  }
  if (url === null) {
    return (
      <Skeleton
        data-slot="timeline-image-loading"
        className={compact ? "size-14" : "h-32 w-48"}
      />
    );
  }
  const alt = name ?? mimeType;
  return (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger asChild>
        <Button
          variant="ghost"
          aria-label={t("timeline.image.open")}
          data-slot="timeline-image"
          className={cn(
            "h-auto overflow-hidden p-0",
            compact ? "size-14" : "max-w-xs",
          )}
        >
          <img
            src={url}
            alt={alt}
            loading="lazy"
            className={cn(
              "object-cover",
              compact ? "size-14" : "max-h-48 w-auto max-w-full",
            )}
          />
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="max-w-[90vw] sm:max-w-4xl">
        <ResponsiveDialogTitle className="sr-only">{alt}</ResponsiveDialogTitle>
        <img
          src={url}
          alt={alt}
          className="max-h-[80vh] w-full object-contain"
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
