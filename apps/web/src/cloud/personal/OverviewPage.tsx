import * as React from "react";

import { useT } from "@/app/preferences-store";
import { formatBytes } from "@/lib/format";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Progress, progressToneFor } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import { EmptyState } from "@/ui/state";
import { useHosts } from "../hosts/data";
import { HostTable } from "../hosts/HostDirectory";
import { RouteLink } from "../RouteLink";
import { navigate } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { PERSONAL_SPACE } from "../space";
import { InlineError } from "../ui/InlineError";
import {
  usePlan,
  useReceivedInvitations,
  useSpaces,
  useTrustRequests,
  useUsage,
} from "./data";

const PREVIEW_ROWS = 5;
const HOSTS_FETCHED = 200;

/** 统计卡：标题 + 一个 15/500 的数字。 */
function Stat({
  title,
  loading,
  error,
  onRetry,
  children,
}: {
  title: string;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading ? (
          <Skeleton className="h-5 w-24" />
        ) : error ? (
          <InlineError error={error} onRetry={onRetry} />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

const value = "text-section font-medium tabular-nums";

/** 个人 · 概览（云端控制台 §3.2.1）：主机 / 本月流量 / 计划三张卡，待处理，主机前 5 行。 */
export function OverviewPage() {
  const t = useT();
  const hosts = useHosts(PERSONAL_SPACE, {}, HOSTS_FETCHED);
  const plan = usePlan();
  const usage = useUsage();
  const trust = useTrustRequests();
  const invitations = useReceivedInvitations();
  const spaces = useSpaces();

  const rows = hosts.data?.pages.flatMap((page) => page.sources) ?? [];
  const traffic = usage.data?.usage.find((entry) => entry.metric === "traffic");
  const percent =
    traffic && traffic.limit ? (traffic.value / traffic.limit) * 100 : null;
  const planKey = plan.data ? `cloud.billing.${plan.data.plan}` : "";
  const planName = plan.data
    ? t(planKey) === planKey
      ? plan.data.plan
      : t(planKey)
    : "";
  const slugOf = (teamId: string | null) =>
    teamId === null
      ? undefined
      : spaces.data?.spaces.find(
          (space) => space.kind === "team" && space.teamId === teamId,
        );

  const pending = [
    ...(trust.data?.requests ?? []).map((request) => {
      const team = slugOf(request.teamId);
      return {
        id: request.requestId,
        label: t("cloud.trust.summary", {
          member: request.member.displayName,
          device: request.device.name,
          host: request.sourceName,
        }),
        href: team && team.kind === "team" ? `/t/${team.slug}/trust` : null,
      };
    }),
    ...(invitations.data?.invitations ?? [])
      .filter((entry) => entry.state === "pending")
      .map((entry) => ({
        id: entry.invitationId,
        label: t("cloud.overview.invited", { name: entry.invitedBy }),
        href: null,
      })),
  ];

  return (
    <>
      <PageHeader title={t("cloud.nav.overview")} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat
          title={t("cloud.billing.hosts")}
          loading={hosts.isPending}
          error={hosts.error}
          onRetry={() => void hosts.refetch()}
        >
          <span className={value}>
            {t("cloud.overview.hostsOnline", {
              online: rows.filter((row) => row.online).length,
              total: rows.length,
            })}
          </span>
        </Stat>
        <Stat
          title={t("cloud.billing.traffic")}
          loading={usage.isPending}
          error={usage.error}
          onRetry={() => void usage.refetch()}
        >
          <span className={value}>
            {traffic
              ? t("cloud.billing.of", {
                  used: formatBytes(traffic.value),
                  limit:
                    traffic.limit === null
                      ? t("cloud.billing.unlimited")
                      : formatBytes(traffic.limit),
                })
              : formatBytes(0)}
          </span>
          {percent === null ? null : (
            <>
              <Progress
                value={percent}
                tone={progressToneFor(percent)}
                aria-label={t("cloud.billing.traffic")}
              />
              {percent >= 80 ? (
                <Badge variant="outline" className="self-start">
                  {t(
                    percent >= 100
                      ? "cloud.billing.atLimit"
                      : "cloud.billing.nearLimit",
                  )}
                </Badge>
              ) : null}
            </>
          )}
        </Stat>
        <Stat
          title={t("cloud.billing.plan")}
          loading={plan.isPending}
          error={plan.error}
          onRetry={() => void plan.refetch()}
        >
          <span className={value}>{planName}</span>
        </Stat>
      </div>

      {pending.length > 0 ? (
        <div className="mb-6">
          <SettingsGroup title={t("cloud.overview.pending")}>
            {pending.map((entry) => (
              <SettingsRow key={entry.id} label={entry.label}>
                {entry.href ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(entry.href!)}
                  >
                    {t("cloud.common.view")}
                  </Button>
                ) : null}
              </SettingsRow>
            ))}
          </SettingsGroup>
        </div>
      ) : null}

      <section aria-labelledby="overview-hosts" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 id="overview-hosts" className="text-body font-medium">
            {t("cloud.nav.hosts")}
          </h2>
          <Button asChild variant="link" size="sm">
            <RouteLink href="/me/hosts">{t("cloud.common.viewAll")}</RouteLink>
          </Button>
        </div>
        {hosts.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : hosts.isError ? (
          <InlineError
            error={hosts.error}
            onRetry={() => void hosts.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t("cloud.hosts.empty")} />
        ) : (
          <HostTable
            space={PERSONAL_SPACE}
            rows={rows.slice(0, PREVIEW_ROWS)}
          />
        )}
      </section>
    </>
  );
}
