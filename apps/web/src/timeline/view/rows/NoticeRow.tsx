import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TimelineNoticeItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Separator } from "@/ui/separator";
import { memoRow } from "../row-memo";

export interface NoticeRowProps {
  item: TimelineNoticeItem;
}

const DETAIL_KEYS = ["name", "message", "attempt", "reason", "code"] as const;

/** `code` 有文案就用文案，没有就原样显示。 */
function detailOf(
  params: TimelineNoticeItem["params"],
  t: (key: string) => string,
): string {
  for (const key of DETAIL_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value !== "") {
      if (key !== "code") return value;
      const text = t(`timeline.notice.error.${value}`);
      return text === `timeline.notice.error.${value}` ? value : text;
    }
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** 居中一行小字：模式、模型、压缩、重试、驱动切换、休眠；压缩带摘要时可折叠展开。 */
function NoticeRowImpl({ item }: NoticeRowProps) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const detail = detailOf(item.params, t);
  const summary =
    typeof item.params.summary === "string" ? item.params.summary : "";
  const label = (
    <>
      {t(`timeline.notice.${item.code}`)}
      {detail !== "" && ` · ${detail}`}
    </>
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="timeline-notice"
      data-notice={item.code}
      className="py-0.5 text-caption text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <Separator className="flex-1" />
        {summary === "" ? (
          <span className="max-w-[70%] truncate">{label}</span>
        ) : (
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="max-w-[70%] gap-1 font-normal text-muted-foreground"
            >
              {open ? <ChevronDown /> : <ChevronRight />}
              <span className="truncate">{label}</span>
            </Button>
          </CollapsibleTrigger>
        )}
        <Separator className="flex-1" />
      </div>
      {summary !== "" && (
        <CollapsibleContent
          data-slot="timeline-notice-summary"
          className="px-4 pt-1 text-meta whitespace-pre-wrap"
        >
          {summary}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

export const NoticeRow = memoRow(NoticeRowImpl);
