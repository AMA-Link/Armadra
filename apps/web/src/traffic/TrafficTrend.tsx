import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, XAxis } from "recharts";

import { TRAFFIC_QUERY_KEY, trafficSeries } from "../api/traffic";
import { usePreferencesStore, useT } from "../app/preferences-store";
import { formatBytes } from "../lib/format";
import { Loadable } from "@/loading/Loadable";
import { Skeleton } from "@/ui/skeleton";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/ui/chart";

export interface TrafficTrendProps {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * 流量卡片里的时间趋势（契约 §76 `traffic.series`）：按本地日分桶的上行 / 下行
 * 叠柱，随卡片的时间范围走；没有流量时整块不出现。
 */
export function TrafficTrend({ fromMs, toMs }: TrafficTrendProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const series = useQuery({
    queryKey: [...TRAFFIC_QUERY_KEY, "series", fromMs, toMs],
    queryFn: () =>
      trafficSeries({
        fromMs,
        toMs,
        bucket: "day",
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      }),
    retry: false,
  });
  const config = useMemo<ChartConfig>(
    () => ({
      up: { label: t("traffic.up"), color: "var(--chart-1)" },
      down: { label: t("traffic.down"), color: "var(--chart-2)" },
    }),
    [t],
  );
  const day = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale],
  );
  const points = series.data?.points ?? [];
  if (points.length === 0 && !series.isLoading) return null;
  const rows = points.map((point) => ({
    at: point.bucketStartMs,
    up: point.bytesOut,
    down: point.bytesIn,
  }));
  return (
    <Loadable
      loading={series.isLoading}
      skeleton={
        <Skeleton
          role="status"
          aria-busy="true"
          aria-label={t("state.loading")}
          className="h-24 w-full"
        />
      }
    >
      <ChartContainer
        config={config}
        data-slot="traffic-trend"
        role="img"
        aria-label={t("traffic.trend")}
        className="aspect-auto h-24 w-full"
      >
        <BarChart data={rows} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
          <XAxis
            dataKey="at"
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            tickFormatter={(value: number) => day.format(value)}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  day.format(Number(payload?.[0]?.payload?.at ?? 0))
                }
                formatter={(value, name) => (
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {config[String(name)]?.label}
                    </span>
                    <span className="font-mono tabular-nums">
                      {formatBytes(Number(value))}
                    </span>
                  </span>
                )}
              />
            }
          />
          <Bar
            dataKey="up"
            stackId="traffic"
            fill="var(--color-up)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="down"
            stackId="traffic"
            fill="var(--color-down)"
            isAnimationActive={false}
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </Loadable>
  );
}
