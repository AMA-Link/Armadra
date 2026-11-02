import * as React from "react";

import { usePreferencesStore } from "@/app/preferences-store";
import {
  formatDate,
  formatElapsedTime,
  formatRelativeTime,
} from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/**
 * 相对时间（「3 小时前」），悬停给绝对时间（云端控制台 §3.0 时间）。缺省是已经发生的时刻，
 * 略超前（服务端时钟快）也写「刚刚」；到期这类本来就在将来的给 `future`。
 */
export function RelativeTime({
  ms,
  future = false,
}: {
  ms: number;
  future?: boolean;
}) {
  const locale = usePreferencesStore((state) => state.locale);
  const absolute = React.useMemo(
    () => formatDate(ms, { dateStyle: "medium", timeStyle: "short" }, locale),
    [locale, ms],
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={new Date(ms).toISOString()}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- tooltip 触发器：键盘聚焦时才能读到绝对时间
          tabIndex={0}
          className="tabular-nums"
        >
          {future ? formatRelativeTime(ms) : formatElapsedTime(ms)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{absolute}</TooltipContent>
    </Tooltip>
  );
}
