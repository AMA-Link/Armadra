import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  DEFAULT_TRAFFIC_RETENTION_DAYS,
  TRAFFIC_RETENTION_CHOICES,
  type TrafficRow,
} from "@armadra/shared";

import {
  TRAFFIC_QUERY_KEY,
  clearTraffic,
  trafficLive,
  trafficSummary,
} from "../api/traffic";
import { useT } from "../app/preferences-store";
import { formatBytes } from "../lib/format";
import { useRuntimeSettings } from "../panels/settings/use-runtime-settings";
import { Loadable } from "@/loading/Loadable";
import { Skeleton } from "@/ui/skeleton";
import { Badge } from "@/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { TrafficBreakdown, type TrafficBreakdownRow } from "./TrafficBreakdown";
import { TrafficTrend } from "./TrafficTrend";

const DAY_MS = 86_400_000;
const LIVE_POLL_MS = 5_000;

type Range = "7d" | "30d" | "all";
type Group = "peer" | "category";

const RANGES: readonly Range[] = ["7d", "30d", "all"];

function fromOf(range: Range, now: number): number {
  if (range === "7d") return now - 7 * DAY_MS;
  if (range === "30d") return now - 30 * DAY_MS;
  return 0;
}

/**
 * 远程访问页「这台电脑」的流量段（契约 §76，设计 §6.6）：经远程服务收发的字节，
 * 7 天 / 30 天 / 全部，按设备或按类别；有对端在线时顶部一枚徽标带当前速率；底部
 * 清零与保留期。数字来自本机 core，按 1024 进制显示。
 */
export function HostTraffic() {
  const t = useT();
  const queryClient = useQueryClient();
  const [range, setRange] = React.useState<Range>("7d");
  const [group, setGroup] = React.useState<Group>("peer");
  const [now] = React.useState(Date.now);
  const summary = useQuery({
    queryKey: [...TRAFFIC_QUERY_KEY, "summary", range, group],
    queryFn: () =>
      trafficSummary({
        fromMs: fromOf(range, now),
        toMs: now + DAY_MS,
        groupBy: group,
      }),
    retry: false,
  });
  const live = useQuery({
    queryKey: [...TRAFFIC_QUERY_KEY, "live"],
    queryFn: trafficLive,
    refetchInterval: LIVE_POLL_MS,
    retry: false,
  });
  const { settings, save } = useRuntimeSettings({ scope: "local" });
  const clear = useMutation({
    mutationFn: clearTraffic,
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: TRAFFIC_QUERY_KEY }),
  });

  if (summary.isError) return null;
  const rows = (summary.data?.rows ?? []).filter(
    (row) => row.peerKind !== "tunnel" && row.key !== "transport",
  );
  const totals = rows.reduce(
    (sum, row) => ({
      up: sum.up + row.bytesOut,
      down: sum.down + row.bytesIn,
      streams: sum.streams + row.streams,
    }),
    { up: 0, down: 0, streams: 0 },
  );
  const labelOf = (row: TrafficRow): string => {
    if (group === "category") return t(`traffic.category.${row.key}`);
    if (row.peerKind === "anonymous") return t("traffic.peer.anonymous");
    return row.label || t("traffic.peer.unknown");
  };
  const breakdown: TrafficBreakdownRow[] = rows.map((row) => ({
    key: `${row.peerKind}:${row.key}`,
    label: labelOf(row),
    up: row.bytesOut,
    down: row.bytesIn,
  }));
  const channels = live.data?.channels ?? [];
  const rateUp = channels.reduce((sum, one) => sum + one.rateOut, 0);
  const rateDown = channels.reduce((sum, one) => sum + one.rateIn, 0);
  const retention =
    settings.data?.traffic?.retentionDays ??
    summary.data?.retentionDays ??
    DEFAULT_TRAFFIC_RETENTION_DAYS;

  return (
    <Card data-slot="host-traffic" size="sm">
      <CardHeader>
        <CardTitle>{t("traffic.title")}</CardTitle>
        {channels.length > 0 && (
          <CardAction>
            <Badge variant="outline" className="tabular-nums">
              {t("traffic.live", {
                count: channels.length,
                up: formatBytes(rateUp),
                down: formatBytes(rateDown),
              })}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-(--space-section)">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={range}
            onValueChange={(value) => setRange(value as Range)}
          >
            <TabsList variant="segmented" size="sm">
              {RANGES.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(`traffic.range.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={group}
            onValueChange={(next) => next && setGroup(next as Group)}
          >
            <ToggleGroupItem value="peer">
              {t("traffic.group.peer")}
            </ToggleGroupItem>
            <ToggleGroupItem value="category">
              {t("traffic.group.category")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <TrafficTrend fromMs={fromOf(range, now)} toMs={now + DAY_MS} />
        <Loadable
          loading={summary.isLoading}
          skeleton={<TrafficSkeleton label={t("state.loading")} />}
        >
          <TrafficBreakdown
            up={totals.up}
            down={totals.down}
            streams={totals.streams}
            rows={breakdown}
            clearTitle={t("traffic.clearHost")}
            onClear={() => clear.mutate()}
            footer={
              <Select
                value={String(retention)}
                disabled={!settings.data}
                onValueChange={(value) =>
                  save.mutate(
                    { traffic: { retentionDays: Number(value) } },
                    {
                      onSuccess: () =>
                        void queryClient.invalidateQueries({
                          queryKey: TRAFFIC_QUERY_KEY,
                        }),
                    },
                  )
                }
              >
                <SelectTrigger size="sm" aria-label={t("traffic.retention")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRAFFIC_RETENTION_CHOICES.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {t("traffic.retention.days", { days })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </Loadable>
      </CardContent>
    </Card>
  );
}

/** 流量段首取时的占位：三格 + 三条分项（趋势柱区自带占位），与 `TrafficBreakdown` 同一套间距。 */
function TrafficSkeleton({ label }: { label: string }) {
  return (
    <div
      data-slot="traffic-skeleton"
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex flex-col gap-(--space-section)"
    >
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((cell) => (
          <Skeleton key={cell} className="h-[62px]" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
