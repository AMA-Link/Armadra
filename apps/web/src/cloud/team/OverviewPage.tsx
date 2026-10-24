import { useT } from "@/app/preferences-store";
import { formatBytes } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Progress, progressToneFor } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import { EmptyState } from "@/ui/state";
import { tp } from "../i18n-plural";
import { useHosts } from "../hosts/data";
import { HostTable } from "../hosts/HostDirectory";
import { Stat, statValue } from "../personal/OverviewPage";
import { RouteLink } from "../RouteLink";
import { PageHeader } from "../shell/PageHeader";
import type { TeamRole } from "../shell/model";
import { InlineError } from "../ui/InlineError";
import { spaceBase } from "../space";
import { useMembers, useTeamUsage, type TeamSpace } from "./data";
import { teamCaps } from "./roles";

const PREVIEW_ROWS = 5;
const HOSTS_FETCHED = 200;

/**
 * 团队 · 概览（云端控制台 §3.3.1）：主机 / 成员 / 本月流量 / 计划四张卡，按角色渲染——
 * guest 只有「主机」和可达的主机列表，billing 没有「主机」。
 */
export function OverviewPage({
  space,
  role,
  plan,
}: {
  space: TeamSpace;
  role: TeamRole;
  plan: string;
}) {
  const t = useT();
  const show = teamCaps(role).overview;
  const hosts = useHosts(space, {}, HOSTS_FETCHED, show.hosts);
  const members = useMembers(space, show.members);
  const usage = useTeamUsage(space, show.traffic);

  const rows = hosts.data?.pages.flatMap((page) => page.sources) ?? [];
  const more = (hosts.data?.pages.at(-1)?.nextCursor ?? null) !== null;
  const people = members.data?.members ?? [];
  const guests = people.filter((member) => member.role === "guest").length;
  const traffic = usage.data?.usage.find((entry) => entry.metric === "traffic");
  const percent =
    traffic && traffic.limit ? (traffic.value / traffic.limit) * 100 : null;
  const planKey = `cloud.billing.${plan}`;
  const planName = t(planKey) === planKey ? plan : t(planKey);

  return (
    <>
      <PageHeader title={t("cloud.nav.overview")} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {show.hosts ? (
          <Stat
            title={t("cloud.billing.hosts")}
            loading={hosts.isPending}
            error={hosts.error}
            onRetry={() => void hosts.refetch()}
          >
            <span className={statValue}>
              {t("cloud.team.hostsOnline", {
                online: rows.filter((row) => row.online).length,
                total: more ? `${HOSTS_FETCHED}+` : rows.length,
              })}
            </span>
          </Stat>
        ) : null}
        {show.members ? (
          <Stat
            title={t("cloud.team.members")}
            loading={members.isPending}
            error={members.error}
            onRetry={() => void members.refetch()}
          >
            <span className={statValue}>
              {tp("cloud.team.membersCount", people.length - guests)}
            </span>
            {guests > 0 ? (
              <span className="text-caption text-muted-foreground">
                {tp("cloud.team.guestsCount", guests)}
              </span>
            ) : null}
          </Stat>
        ) : null}
        {show.traffic ? (
          <Stat
            title={t("cloud.team.traffic")}
            loading={usage.isPending}
            error={usage.error}
            onRetry={() => void usage.refetch()}
          >
            <span className={statValue}>
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
                  aria-label={t("cloud.team.traffic")}
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
        ) : null}
        {show.plan ? (
          <Stat
            title={t("cloud.team.plan")}
            loading={false}
            error={null}
            onRetry={() => undefined}
          >
            <span className={statValue}>{planName}</span>
          </Stat>
        ) : null}
      </div>

      {role === "guest" ? (
        <section
          aria-labelledby="team-overview-hosts"
          className="flex flex-col gap-2"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id="team-overview-hosts" className="text-body font-medium">
              {t("cloud.nav.hosts")}
            </h2>
            <Button asChild variant="link" size="sm">
              <RouteLink href={`${spaceBase(space)}/hosts`}>
                {t("cloud.common.viewAll")}
              </RouteLink>
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
            <HostTable space={space} rows={rows.slice(0, PREVIEW_ROWS)} />
          )}
        </section>
      ) : null}
    </>
  );
}
