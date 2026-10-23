import * as React from "react";
import { Search } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { SkeletonList } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { describeFailure } from "../api/errors";
import { RouteLink } from "../RouteLink";
import { navigate, type RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { DataList, type DataColumn } from "../ui/DataList";
import { TypedConfirm } from "../ui/TypedConfirm";
import { OpsError, useFormatDate, usePlanLabel } from "./common";
import {
  useSetTenantStatus,
  useTenantDetail,
  useTenants,
  type AdminAccount,
  type AdminTeam,
  type Tenant,
  type TenantKind,
} from "./data";

const detailHref = (kind: TenantKind, id: string, q: string) => {
  const query = new URLSearchParams({ kind });
  if (q !== "") query.set("q", q);
  return `/ops/tenants/${encodeURIComponent(id)}?${query}`;
};
const listHref = (q: string) =>
  q === "" ? "/ops" : `/ops?q=${encodeURIComponent(q)}`;

function StatusBadge({ suspended }: { suspended: boolean }) {
  const t = useT();
  return (
    <Badge variant={suspended ? "destructive" : "success"}>
      {t(suspended ? "cloud.ops.suspended" : "cloud.ops.active")}
    </Badge>
  );
}

const isSuspended = (status: string) => status !== "active";

/** 租户 `/ops`、`/ops/tenants/:id`（云端控制台 §3.4.1）：搜索账号与团队，点行开详情。 */
export function TenantsPage({ match }: { match: RouteMatch }) {
  const t = useT();
  const plan = usePlanLabel();
  const date = useFormatDate();
  const q = (match.query.get("q") ?? "").trim();
  const [draft, setDraft] = React.useState(q);
  React.useEffect(() => setDraft(q), [q]);
  const result = useTenants(q);
  const rows = React.useMemo(
    () => result.data?.pages.flatMap((page) => page.tenants) ?? [],
    [result.data],
  );

  const columns = React.useMemo<DataColumn<Tenant>[]>(
    () => [
      {
        id: "kind",
        header: t("cloud.ops.kind"),
        cell: (row) => (
          <Badge variant="outline">
            {t(
              row.kind === "account"
                ? "cloud.ops.kindAccount"
                : "cloud.ops.kindTeam",
            )}
          </Badge>
        ),
      },
      {
        id: "name",
        header: t("cloud.ops.name"),
        role: "primary",
        cell: (row) => (
          <RouteLink
            href={detailHref(row.kind, row.id, q)}
            className="rounded-control underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            translate="no"
          >
            {row.name}
          </RouteLink>
        ),
      },
      {
        id: "plan",
        header: t("cloud.ops.plan"),
        cell: (row) => plan(row.plan),
      },
      {
        id: "hosts",
        header: t("cloud.ops.hosts"),
        numeric: true,
        cell: (row) => row.hostCount,
      },
      {
        id: "status",
        header: t("cloud.ops.status"),
        role: "trailing",
        cell: (row) => <StatusBadge suspended={isSuspended(row.status)} />,
      },
      {
        id: "created",
        header: t("cloud.ops.created"),
        cell: (row) => date(row.createdAtMs),
      },
    ],
    [t, plan, date, q],
  );

  const close = () => navigate(listHref(q));
  const kindParam = match.query.get("kind");
  const detail: { kind: TenantKind; id: string } | null =
    match.id === "opsTenant" &&
    match.params.id !== undefined &&
    (kindParam === "account" || kindParam === "team")
      ? { kind: kindParam, id: match.params.id }
      : null;

  return (
    <>
      <PageHeader title={t("cloud.nav.tenants")} />
      <form
        role="search"
        className="mb-6"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(listHref(draft.trim()));
        }}
      >
        <InputGroup className="max-w-md">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            enterKeyHint="search"
            aria-label={t("cloud.ops.search")}
            placeholder={t("cloud.ops.search")}
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </InputGroup>
      </form>
      {q === "" ? null : result.isPending ? (
        <SkeletonList rows={5} size="tall" />
      ) : result.isError ? (
        <OpsError error={result.error} onRetry={() => void result.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("cloud.ops.noTenant", { query: q })} />
      ) : (
        <div className="flex flex-col gap-4">
          <DataList
            caption={t("cloud.nav.tenants")}
            rows={rows}
            columns={columns}
            rowKey={(row) => `${row.kind}:${row.id}`}
            onRowOpen={(row) => navigate(detailHref(row.kind, row.id, q))}
          />
          {result.hasNextPage ? (
            <Button
              variant="outline"
              className="self-start"
              loading={result.isFetchingNextPage}
              onClick={() => void result.fetchNextPage()}
            >
              {t("cloud.ops.loadMore")}
            </Button>
          ) : null}
        </div>
      )}
      {detail ? (
        <TenantDialog
          key={`${detail.kind}:${detail.id}`}
          kind={detail.kind}
          id={detail.id}
          onClose={close}
        />
      ) : null}
    </>
  );
}

type Detail = AdminAccount | AdminTeam;

const nameOf = (detail: Detail) =>
  "slug" in detail ? detail.name : detail.displayName;
const suspendedOf = (detail: Detail) => detail.status !== "active";

/** 租户详情（`ResponsiveDialog` 520，手机底部）：只读元数据加最近的运营动作，停用 / 恢复都要理由与输入名称确认。 */
function TenantDialog({
  kind,
  id,
  onClose,
}: {
  kind: TenantKind;
  id: string;
  onClose: () => void;
}) {
  const t = useT();
  const plan = usePlanLabel();
  const date = useFormatDate();
  const query = useTenantDetail(kind, id);
  const setStatus = useSetTenantStatus();
  const [confirm, setConfirm] = React.useState<"suspend" | "restore" | null>(
    null,
  );
  const detail = query.data;

  const run = async (suspended: boolean, reason: string) => {
    if (!detail) return;
    const name = nameOf(detail);
    try {
      await setStatus.mutateAsync({ kind, id, suspended, reason });
      toast.success(
        t(suspended ? "cloud.ops.suspendDone" : "cloud.ops.restoreDone", {
          name,
        }),
      );
    } catch (failure) {
      toast.error(describeFailure(failure));
      throw failure;
    }
  };

  const value = (node: React.ReactNode) => (
    <span className="text-muted-foreground tabular-nums">{node}</span>
  );

  return (
    <>
      <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
        <ResponsiveDialogContent aria-describedby={undefined}>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate" translate="no">
                {detail ? nameOf(detail) : ""}
              </span>
              {detail ? <StatusBadge suspended={suspendedOf(detail)} /> : null}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          {query.isPending ? (
            <SkeletonList rows={5} />
          ) : query.isError ? (
            <OpsError
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          ) : (
            <div className="flex flex-col gap-6">
              <SettingsGroup>
                {"email" in query.data && query.data.email ? (
                  <SettingsRow label={t("cloud.ops.email")}>
                    <span
                      className="min-w-0 truncate text-muted-foreground"
                      translate="no"
                    >
                      {query.data.email}
                    </span>
                  </SettingsRow>
                ) : null}
                <SettingsRow label={t("cloud.ops.plan")}>
                  {value(plan(query.data.plan))}
                </SettingsRow>
                {query.data.seats === undefined ? null : (
                  <SettingsRow label={t("cloud.ops.seats")}>
                    {value(query.data.seats)}
                  </SettingsRow>
                )}
                {"memberCount" in query.data ? (
                  <SettingsRow label={t("cloud.ops.members")}>
                    {value(query.data.memberCount)}
                  </SettingsRow>
                ) : (
                  <SettingsRow label={t("cloud.ops.teams")}>
                    {value(query.data.teamCount)}
                  </SettingsRow>
                )}
                <SettingsRow label={t("cloud.ops.hosts")}>
                  {value(query.data.hostCount)}
                </SettingsRow>
                {query.data.relayBytesMonth === undefined ? null : (
                  <SettingsRow label={t("cloud.ops.traffic")}>
                    {value(formatBytes(query.data.relayBytesMonth))}
                  </SettingsRow>
                )}
                {"lastSeenAtMs" in query.data &&
                query.data.lastSeenAtMs !== null ? (
                  <SettingsRow label={t("cloud.ops.lastSeen")}>
                    {value(formatRelativeTime(query.data.lastSeenAtMs))}
                  </SettingsRow>
                ) : null}
                <SettingsRow label={t("cloud.ops.created")}>
                  {value(date(query.data.createdAtMs))}
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title={t("cloud.ops.recentActions")}>
                {(query.data.recentActions ?? []).length === 0 ? (
                  <SettingsRow label={t("cloud.ops.noActions")} />
                ) : (
                  (query.data.recentActions ?? []).map((event) => (
                    <SettingsRow key={event.eventId} label={event.action}>
                      {value(formatRelativeTime(event.atMs))}
                    </SettingsRow>
                  ))
                )}
              </SettingsGroup>
            </div>
          )}
          {detail ? (
            <ResponsiveDialogFooter>
              <Button
                variant={suspendedOf(detail) ? "outline" : "destructive"}
                onClick={() =>
                  setConfirm(suspendedOf(detail) ? "restore" : "suspend")
                }
              >
                {t(
                  suspendedOf(detail)
                    ? "cloud.ops.restore"
                    : "cloud.ops.suspend",
                )}
              </Button>
            </ResponsiveDialogFooter>
          ) : null}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      {detail && confirm ? (
        <TypedConfirm
          open
          reason
          onOpenChange={(open) => !open && setConfirm(null)}
          title={t(
            confirm === "suspend"
              ? "cloud.ops.suspendTitle"
              : "cloud.ops.restoreTitle",
            { name: nameOf(detail) },
          )}
          expected={nameOf(detail)}
          actionLabel={t(
            confirm === "suspend" ? "cloud.ops.suspend" : "cloud.ops.restore",
          )}
          onConfirm={(reason) => run(confirm === "suspend", reason)}
        />
      ) : null}
    </>
  );
}
