import * as React from "react";

import { formatDuration } from "./format";

/**
 * 进行中的条目从 `since` 起实时跳动的时长（每秒一跳）；不在进行中时不起计时器。
 * `fixed` 给了就用它当「现在」（测试用）。
 */
export function useElapsed(
  active: boolean,
  since: number,
  fixed?: number | undefined,
): string {
  const [now, setNow] = React.useState(() => fixed ?? Date.now());
  React.useEffect(() => {
    if (!active || fixed !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, fixed]);
  return formatDuration(Math.max(0, (fixed ?? now) - since));
}
