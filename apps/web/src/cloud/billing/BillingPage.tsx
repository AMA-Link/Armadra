import * as React from "react";
import { Bar, BarChart, XAxis } from "recharts";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { formatBytes } from "@/lib/format";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { Alert, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/ui/chart";
import { Progress } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import { toCloudError } from "../api/errors";
import { tp } from "../i18n-plural";
import { navigate } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { spaceBase, type CloudSpace } from "../space";
import { PageState } from "../ui/PageState";
import {
  useBillingUsage,
  usePlan,
  type BillingPlan,
  type BillingUsage,
  type UsageEntry,
} from "./data";
import {
  QUOTA_ORDER,
  QUOTA_TONE,
  quotaLevel,
  quotaPercent,
  type QuotaMetric,
} from "./quota";

function useDate() {
  const locale = usePreferencesStore((state) => state.locale);
  return React.useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
    });
    return (ms: number) => format.format(ms);
  }, [locale]);
}

/** 计划卡：计划名 · 席位 · 续费或试用到期；逾期、已取消、到期不续各一枚徽标。 */
function PlanCard({ plan }: { plan: BillingPlan }) {
  const t = useT();
  const date = useDate();
  const key = `cloud.billing.${plan.plan}`;
  const name = t(key) === key ? plan.plan : t(key);
  // 免费版没有续费：云端照样报本周期结束日，不显示它。
  const free = plan.plan === "free";
  const when = free
    ? null
    : plan.status === "trialing" && plan.trialEndsAtMs != null
      ? t("cloud.billing.trialEnds", { date: date(plan.trialEndsAtMs) })
      : plan.periodEndsAtMs !== null
        ? t(
            plan.cancelAtPeriodEnd
              ? "cloud.billing.endsOn"
              : "cloud.billing.renews",
            { date: date(plan.periodEndsAtMs) },
          )
        : null;
  return (
    <Card data-slot="billing-plan">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4">
        <h2 className="text-body font-medium">{name}</h2>
        <span className="text-muted-foreground" aria-hidden>
          ·
        </span>
        <span className="text-muted-foreground tabular-nums">
          {tp("cloud.billing.seats", plan.seats)}
        </span>
        {when ? (
          <>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <span className="text-muted-foreground">{when}</span>
          </>
        ) : null}
        {plan.status === "past_due" ? (
          <Badge variant="destructive">{t("cloud.billing.pastDue")}</Badge>
        ) : plan.status === "canceled" ? (
          <Badge variant="outline">{t("cloud.billing.canceled")}</Badge>
        ) : null}
      </div>
    </Card>
  );
}

/** 一项配额：标签 · 已用 / 上限 · 进度条（不限没有条）；≥ 80% 接近上限，100% 已达上限。 */
function QuotaRow({ entry }: { entry: UsageEntry }) {
  const t = useT();
  const metric = entry.metric as QuotaMetric;
  const bytes = metric === "traffic";
  const show = (value: number) =>
    bytes ? formatBytes(value) : String(Math.round(value));
  const percent = quotaPercent(entry.value, entry.limit);
  const level = quotaLevel(percent);
  const label = t(
    `cloud.billing.${metric === "concurrent" ? "connections" : metric}`,
  );
  return (
    <SettingsRow label={label}>
      <div
        className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1"
        data-metric={metric}
      >
        <span className="tabular-nums">
          {t("cloud.billing.of", {
            used: show(entry.value),
            limit:
              entry.limit === null
                ? t("cloud.billing.unlimited")
                : show(entry.limit),
          })}
        </span>
        {level === "ok" ? null : (
          <Badge variant="outline">
            {t(
              level === "full"
                ? "cloud.billing.atLimit"
                : "cloud.billing.nearLimit",
            )}
          </Badge>
        )}
        {percent === null ? null : (
          <Progress
            className="w-40 max-sm:w-full"
            value={percent}
            tone={QUOTA_TONE[level]}
            aria-label={label}
          />
        )}
      </div>
    </SettingsRow>
  );
}

/** 每日流量：单系列柱状图；另给一份读屏用的数据表。 */
function DailyTraffic({
  series,
}: {
  series: NonNullable<BillingUsage["series"]>;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const day = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );
  const config = React.useMemo<ChartConfig>(
    () => ({
      bytes: { label: t("cloud.billing.traffic"), color: "var(--brand)" },
    }),
    [t],
  );
  const rows = series.map((point) => ({
    at: point.startMs,
    bytes: point.relayBytes,
  }));
  return (
    <section className="flex flex-col gap-2" aria-labelledby="billing-daily">
      <h3 id="billing-daily" className="px-0.5 text-body font-medium">
        {t("cloud.billing.daily")}
      </h3>
      <ChartContainer
        config={config}
        data-slot="billing-daily"
        role="img"
        aria-label={t("cloud.billing.daily")}
        className="aspect-auto h-32 w-full"
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
                hideIndicator
                labelFormatter={(_, payload) =>
                  day.format(Number(payload?.[0]?.payload?.at ?? 0))
                }
                formatter={(value) => (
                  <span className="font-mono tabular-nums">
                    {formatBytes(Number(value))}
                  </span>
                )}
              />
            }
          />
          <Bar
            dataKey="bytes"
            fill="var(--color-bytes)"
            isAnimationActive={false}
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>{t("cloud.billing.daily")}</caption>
        <thead>
          <tr>
            <th>{t("cloud.billing.date")}</th>
            <th>{t("cloud.billing.traffic")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.at}>
              <td>{day.format(row.at)}</td>
              <td>{formatBytes(row.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * 用量与计划（云端控制台 §3.3.11，M1 只读）：计划卡、各项配额的用量与进度、每日流量。
 * 流量超出上限时页顶一条提示；付款、升级、发票随 M2。
 */
export function BillingPage({ space }: { space: CloudSpace }) {
  const t = useT();
  const plan = usePlan(space);
  const usage = useBillingUsage(space);
  const failed = plan.error ?? usage.error;
  const retry = () => {
    void plan.refetch();
    void usage.refetch();
  };
  if (failed)
    return (
      <>
        <PageHeader title={t("cloud.nav.billing")} />
        <PageState
          code={toCloudError(failed).code}
          onRetry={retry}
          onHome={() => navigate(spaceBase(space))}
        />
      </>
    );
  if (!plan.data || !usage.data)
    return (
      <>
        <PageHeader title={t("cloud.nav.billing")} />
        <div
          role="status"
          aria-busy="true"
          aria-label={t("state.loading")}
          className="flex flex-col gap-4"
        >
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </>
    );
  const entries = QUOTA_ORDER.flatMap((metric) => {
    const entry = usage.data.usage.find((row) => row.metric === metric);
    return entry ? [entry] : [];
  });
  const traffic = entries.find((entry) => entry.metric === "traffic");
  const exceeded =
    traffic !== undefined &&
    traffic.limit !== null &&
    traffic.value > traffic.limit;
  const series = usage.data.series ?? [];
  return (
    <>
      <PageHeader title={t("cloud.nav.billing")} />
      <div className="flex flex-col gap-6">
        {exceeded ? (
          <Alert variant="destructive">
            <AlertTitle>{t("cloud.billing.overage")}</AlertTitle>
          </Alert>
        ) : null}
        <PlanCard plan={plan.data} />
        <SettingsGroup title={t("cloud.billing.usage")}>
          {entries.map((entry) => (
            <QuotaRow key={entry.metric} entry={entry} />
          ))}
        </SettingsGroup>
        {series.length > 0 ? <DailyTraffic series={series} /> : null}
      </div>
    </>
  );
}
