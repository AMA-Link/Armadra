import * as React from "react";
import { ChevronLeft } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { SkeletonList } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { LinksView } from "../links/LinksView";
import { RouteLink } from "../RouteLink";
import { navigate, type RouteMatch } from "../router";
import { spaceBase, type CloudSpace } from "../space";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { InlineError } from "../ui/InlineError";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import { HostMenu, HostStatus, RevokeHostConfirm } from "./HostActions";
import {
  useHost,
  useHostAccess,
  useRevokeAccess,
  type HostAccess,
  type HostDetail as HostDetailData,
} from "./data";

type Tab = "access" | "links" | "settings";

const VIA_KEY = {
  owner: "cloud.hosts.viaOwner",
  link: "cloud.hosts.viaLink",
  team: "cloud.hosts.viaTeam",
} as const;

function AccessTab({
  space,
  host,
}: {
  space: CloudSpace;
  host: HostDetailData;
}) {
  const t = useT();
  const access = useHostAccess(space, host.sourceId);
  const revoke = useRevokeAccess(space, host.sourceId);
  const [target, setTarget] = React.useState<HostAccess | null>(null);

  const columns = React.useMemo<DataColumn<HostAccess>[]>(
    () => [
      {
        id: "who",
        header: t("cloud.hosts.who"),
        role: "primary",
        cell: (row) => <span translate="no">{row.email ?? row.accountId}</span>,
      },
      {
        id: "via",
        header: t("cloud.hosts.via"),
        cell: (row) =>
          row.via in VIA_KEY
            ? t(VIA_KEY[row.via as keyof typeof VIA_KEY])
            : row.via,
      },
      {
        id: "granted",
        header: t("cloud.hosts.grantedAt"),
        cell: (row) => <RelativeTime ms={row.grantedAtMs} />,
      },
    ],
    [t],
  );

  if (access.isPending) return <SkeletonList rows={3} />;
  if (access.isError)
    return (
      <InlineError error={access.error} onRetry={() => void access.refetch()} />
    );
  const rows = access.data.access;
  if (rows.length === 0)
    return <EmptyState title={t("cloud.hosts.noAccess")} />;
  const label = target?.email ?? target?.accountId ?? "";
  return (
    <>
      <DataList
        caption={t("cloud.hosts.tabAccess")}
        rows={rows}
        columns={columns}
        rowKey={(row) => row.accountId}
        actionsHeader={t("cloud.hosts.removeAccess")}
        actions={(row) =>
          // 所有者自己的那一行不能撤销。
          row.via === "owner" ? null : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("cloud.hosts.removeAccessNamed", {
                name: row.email ?? row.accountId,
              })}
              onClick={() => setTarget(row)}
            >
              {t("cloud.hosts.removeAccess")}
            </Button>
          )
        }
      />
      <ConfirmAction
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t("cloud.grants.revokeTitle", { name: label, host: host.name })}
        actionLabel={t("cloud.hosts.removeAccess")}
        onConfirm={async () => {
          if (!target) return;
          try {
            await revoke.mutateAsync(target.accountId);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.hosts.removeAccessDone"));
        }}
      />
    </>
  );
}

/** 设置页签：危险操作。团队主机的链接创建者、访客与缺省权限随团队主机页（U5）加进来。 */
function SettingsTab({
  space,
  host,
}: {
  space: CloudSpace;
  host: HostDetailData;
}) {
  const t = useT();
  const [confirm, setConfirm] = React.useState(false);
  return (
    <>
      <SettingsGroup title={t("cloud.common.dangerZone")}>
        <SettingsRow label={t("cloud.hosts.revoke")}>
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            {t("cloud.hosts.revoke")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      {confirm ? (
        <RevokeHostConfirm
          space={space}
          host={host}
          onClose={() => setConfirm(false)}
          onRevoked={() => navigate(`${spaceBase(space)}/hosts`)}
        />
      ) : null}
    </>
  );
}

/**
 * 主机详情（云端控制台 §3.3.5、§3.2.3），个人与团队空间共用：页头（名称、状态、标签、所有者与
 * 最近在线、版本）、页签（访问 · 链接 · 设置，`?tab=` 进地址）。访问与设置只给所有者。
 */
export function HostDetail({
  space,
  match,
}: {
  space: CloudSpace;
  match: RouteMatch;
}) {
  const t = useT();
  const sourceId = match.params.host ?? "";
  const host = useHost(space, sourceId);
  const base = spaceBase(space);
  const requested = match.query.get("tab");

  if (host.isPending)
    return <SkeletonList rows={4} label={t("cloud.nav.hosts")} />;
  if (host.isError)
    return (
      <PageState
        code={toCloudError(host.error).code}
        onRetry={() => void host.refetch()}
        onHome={() => navigate(base)}
      />
    );

  const data = host.data;
  const tabs: Tab[] = data.owner ? ["access", "links", "settings"] : ["links"];
  const tab: Tab = tabs.find((entry) => entry === requested) ?? tabs[0]!;
  const setTab = (value: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", value);
    navigate(`${window.location.pathname}?${params}`, { replace: true });
  };
  const meta = [
    data.ownerName ? <span translate="no">{data.ownerName}</span> : null,
    data.lastSeenAtMs === null
      ? null
      : t("cloud.hosts.lastSeen", {
          time: formatRelativeTime(data.lastSeenAtMs),
        }),
    data.coreVersion
      ? t("cloud.hosts.versionValue", { version: data.coreVersion })
      : null,
  ].filter((node) => node !== null);

  return (
    <>
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mb-2 -ms-2 self-start"
      >
        <RouteLink href={`${base}/hosts`}>
          <ChevronLeft aria-hidden />
          {t("cloud.nav.hosts")}
        </RouteLink>
      </Button>
      <header className="flex flex-col gap-1 pb-6">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1
              className="min-w-0 truncate text-title leading-6 font-semibold text-balance"
              translate="no"
            >
              {data.name}
            </h1>
            <HostStatus online={data.online} />
            {(data.tags ?? []).map((tag) => (
              <Badge key={tag} variant="outline" translate="no">
                {tag}
              </Badge>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <HostMenu
              space={space}
              host={data}
              layout="table"
              onRevoked={() => navigate(`${base}/hosts`)}
            />
          </div>
        </div>
        {meta.length > 0 ? (
          <div className="flex flex-wrap gap-x-1 text-caption text-muted-foreground">
            {meta.map((node, index) => (
              <React.Fragment key={index}>
                {index > 0 ? <span aria-hidden>·</span> : null}
                {node}
              </React.Fragment>
            ))}
          </div>
        ) : null}
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="mb-4">
          {tabs.map((entry) => (
            <TabsTrigger key={entry} value={entry}>
              {t(
                entry === "access"
                  ? "cloud.hosts.tabAccess"
                  : entry === "links"
                    ? "cloud.hosts.tabLinks"
                    : "cloud.hosts.tabSettings",
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {tab === "access" ? (
          <TabsContent value="access">
            <AccessTab space={space} host={data} />
          </TabsContent>
        ) : null}
        {tab === "links" ? (
          <TabsContent value="links">
            <LinksView space={space} sourceId={data.sourceId} variant="tab" />
          </TabsContent>
        ) : null}
        {tab === "settings" ? (
          <TabsContent value="settings">
            <SettingsTab space={space} host={data} />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
