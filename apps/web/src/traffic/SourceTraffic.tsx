import * as React from "react";

import { TRAFFIC_CATEGORIES } from "@armadra/shared";

import { useT } from "../app/preferences-store";
import { formatBytes } from "../lib/format";
import {
  type TrafficLedger,
  type TrafficRange,
  type TrafficTotals,
  trafficLedger,
} from "../sources/traffic-meter";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { TrafficBreakdown } from "./TrafficBreakdown";

const RANGES: readonly TrafficRange[] = ["today", "month", "all"];

/** 账本变了就重渲染（最多一秒一次）。 */
export function useTrafficLedger(
  ledger: TrafficLedger = trafficLedger(),
): TrafficLedger {
  React.useSyncExternalStore(
    (listener) => ledger.subscribe(listener),
    () => ledger.snapshot,
    () => ledger.snapshot,
  );
  return ledger;
}

/** 每个源本月的合计（连接页每行尾部）。 */
export function useMonthTraffic(): Record<string, TrafficTotals> {
  return useTrafficLedger().month();
}

/** 行尾那一小行：`↑ 12 MB ↓ 180 MB`；没有流量不显示。 */
export function MonthTrafficLine({
  totals,
}: {
  totals: TrafficTotals | undefined;
}) {
  const t = useT();
  if (totals === undefined || totals.bytesIn + totals.bytesOut === 0)
    return null;
  const up = formatBytes(totals.bytesOut);
  const down = formatBytes(totals.bytesIn);
  return (
    <span
      data-slot="month-traffic"
      className="text-[length:var(--text-caption)] text-muted-foreground tabular-nums"
      aria-label={t("traffic.monthLine", { up, down })}
    >
      ↑ {up} ↓ {down}
    </span>
  );
}

export interface SourceTrafficProps {
  readonly sourceId: string;
  readonly name: string;
  /** 测试用：换一份账本。 */
  readonly ledger?: TrafficLedger;
}

/**
 * 一个源的流量段（设计 §6.4）：这台客户端经中继与它收发的字节，今日 / 本月 /
 * 全部，按类别的比例条，「清零」。
 */
export function SourceTraffic({ sourceId, name, ledger }: SourceTrafficProps) {
  const t = useT();
  const book = useTrafficLedger(ledger);
  const [range, setRange] = React.useState<TrafficRange>("month");
  const { totals, byCategory } = book.source(sourceId, range);
  const rows = TRAFFIC_CATEGORIES.flatMap((category) => {
    if (category === "transport") return [];
    const cell = byCategory[category];
    return cell === undefined
      ? []
      : [
          {
            key: category,
            label: t(`traffic.category.${category}`),
            up: cell.bytesOut,
            down: cell.bytesIn,
          },
        ];
  });
  return (
    <section
      data-slot="source-traffic"
      className="flex flex-col gap-4"
      aria-label={t("traffic.open", { name })}
    >
      <Tabs
        value={range}
        onValueChange={(value) => setRange(value as TrafficRange)}
      >
        <TabsList className="w-full">
          {RANGES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`traffic.range.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <TrafficBreakdown
        up={totals.bytesOut}
        down={totals.bytesIn}
        streams={totals.streams}
        rows={rows}
        clearTitle={t("traffic.clearTitle", { name })}
        onClear={() => book.clear(sourceId)}
      />
    </section>
  );
}
