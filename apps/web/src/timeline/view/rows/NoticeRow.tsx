import type { TimelineNoticeItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Separator } from "@/ui/separator";
import { memoRow } from "../row-memo";

export interface NoticeRowProps {
  item: TimelineNoticeItem;
}

const DETAIL_KEYS = ["name", "message", "attempt", "reason"] as const;

function detailOf(params: TimelineNoticeItem["params"]): string {
  for (const key of DETAIL_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** 居中一行小字：模式、模型、压缩、重试、驱动切换、休眠。 */
function NoticeRowImpl({ item }: NoticeRowProps) {
  const t = useT();
  const detail = detailOf(item.params);
  return (
    <div
      data-slot="timeline-notice"
      data-notice={item.code}
      className="flex items-center gap-2 py-0.5 text-[11px] text-muted-foreground"
    >
      <Separator className="flex-1" />
      <span className="max-w-[70%] truncate">
        {t(`timeline.notice.${item.code}`)}
        {detail !== "" && ` · ${detail}`}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

export const NoticeRow = memoRow(NoticeRowImpl);
