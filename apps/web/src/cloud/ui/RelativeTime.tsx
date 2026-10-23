import * as React from "react";

import { usePreferencesStore } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/** 相对时间（「3 小时前」），悬停给绝对时间（云端控制台 §3.0 时间）。 */
export function RelativeTime({ ms }: { ms: number }) {
  const locale = usePreferencesStore((state) => state.locale);
  const absolute = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(ms),
    [locale, ms],
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(ms).toISOString()} className="tabular-nums">
          {formatRelativeTime(ms)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{absolute}</TooltipContent>
    </Tooltip>
  );
}
