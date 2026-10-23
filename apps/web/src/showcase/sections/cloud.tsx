import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { usePreferencesStore } from "@/app/preferences-store";
import { CloudApiProvider } from "@/cloud/api/context";
import { createCloudQueryClient, useConsoleSession } from "@/cloud/api/queries";
import type { ConsoleSession } from "@/cloud/ConsoleRoot";
import { createMockApi } from "@/cloud/mock/create-mock-client";
import { ConsoleSidebar, ConsoleShell } from "@/cloud/shell/ConsoleShell";
import { EmbeddedAuth } from "@/cloud/auth/AuthLayout";
import { DevicePage } from "@/cloud/auth/DevicePage";
import { LinkPage } from "@/cloud/auth/LinkPage";
import {
  MOCK_DEVICE_CODES,
  MOCK_LINK,
  MOCK_PERSONAL,
} from "@/cloud/mock/fixtures";
import { PageHeader } from "@/cloud/shell/PageHeader";
import { OpsPage } from "@/cloud/ops/OpsPages";
import { PersonalPage } from "@/cloud/personal/PersonalPages";
import { OPS_QUERY_KEY } from "@/cloud/ops/TenantsPage";
import { matchRoute } from "@/cloud/router";
import { DataList, type DataColumn } from "@/cloud/ui/DataList";
import { PageState } from "@/cloud/ui/PageState";
import { TypedConfirm } from "@/cloud/ui/TypedConfirm";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Progress } from "@/ui/progress";
import { StatusPill } from "@/ui/status-pill";
import {
  CLOUD_COUNTS,
  CLOUD_HOSTS,
  CLOUD_QUOTAS,
  CLOUD_TEAMS,
  type CloudHostRow,
} from "../fixtures/cloud";

const noop = () => undefined;
const resend = () => new Promise<void>(() => undefined);

function useHostColumns(): DataColumn<CloudHostRow>[] {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  return React.useMemo(() => {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const ago = (minutes: number) =>
      minutes < 60
        ? relative.format(-minutes, "minute")
        : minutes < 1440
          ? relative.format(-Math.round(minutes / 60), "hour")
          : relative.format(-Math.round(minutes / 1440), "day");
    return [
      {
        id: "name",
        header: t("showcase.cloud.name"),
        role: "primary",
        cell: (row) => <span translate="no">{row.name}</span>,
      },
      {
        id: "owner",
        header: t("showcase.cloud.owner"),
        role: "sub",
        cell: (row) => <span translate="no">{row.owner}</span>,
      },
      {
        id: "permission",
        header: t("showcase.cloud.permission"),
        role: "sub",
        cell: (row) => t(`workspaceGroups.role.${row.permission}`),
      },
      {
        id: "status",
        header: t("showcase.cloud.status"),
        role: "trailing",
        cell: (row) => (
          <StatusPill
            tone={row.online ? "done" : "idle"}
            label={t(
              row.online ? "showcase.cloud.online" : "showcase.cloud.offline",
            )}
          />
        ),
      },
      {
        id: "tags",
        header: t("showcase.cloud.tags"),
        listCell: (row) => row.tags.join(" ") || null,
        cell: (row) =>
          row.tags.length === 0 ? null : (
            <span className="flex gap-1">
              {row.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </span>
          ),
      },
      {
        id: "seen",
        header: t("showcase.cloud.seen"),
        cell: (row) => ago(row.seenMinutesAgo),
      },
    ];
  }, [t, locale]);
}

/**
 * 账号与空间经 mock 客户端的 `me.get` / `me.spaces` 取（U1b），与真实控制台走同一条路；
 * 取到之前什么也不画。
 */
function MockConsole({
  children,
}: {
  children: (session: ConsoleSession) => React.ReactNode;
}) {
  const [api] = React.useState(() =>
    createMockApi({ operatorAccount: true, operatorSession: true }),
  );
  const [client] = React.useState(createCloudQueryClient);
  return (
    <QueryClientProvider client={client}>
      <CloudApiProvider api={api}>
        <FromSession render={children} />
      </CloudApiProvider>
    </QueryClientProvider>
  );
}

function FromSession({
  render,
}: {
  render: (session: ConsoleSession) => React.ReactNode;
}) {
  const { session } = useConsoleSession();
  return session ? render(session) : null;
}

/**
 * `cloud` 分区（云端控制台 §7 U1a、U1b、U2b、U3、U8）：外壳（带未验证提示与计数）、两种侧栏、整页
 * 四态、设备授权与分享链接落地的公开页、`DataList` 的表格与列表两种渲染、`Progress` 三档、输入确认。外壳随视口宽度
 * 在固定侧栏与顶栏加抽屉之间切换，探针 390 / 768 / 1440 各截一张。
 */
export default function CloudSection() {
  // 租户样本要有搜索结果：搜索词只在 sessionStorage 里（不进地址）。
  sessionStorage.setItem(OPS_QUERY_KEY, "li");
  return (
    <MockConsole>{(session) => <CloudSamples session={session} />}</MockConsole>
  );
}

const FRAGMENT = `${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;
const SAMPLE_LINK = "0123456789abcdef";

/**
 * 公开页二（U2b）：设备授权的请求卡、过期码的错误态，分享链接落地的可加入 / 次数用完（禁用）/
 * 已失效三态。页面用同一个 mock 客户端取数，和真实页面走同一条路；嵌在框里，不当 `main`。
 */
function PublicSamples() {
  const frame = "h-[520px] overflow-hidden rounded-card border border-border";
  return (
    <EmbeddedAuth.Provider value>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={frame}>
          <DevicePage
            code={MOCK_DEVICE_CODES.pending}
            onNeedLogin={noop}
            onDone={noop}
          />
        </div>
        <div className={frame}>
          <DevicePage
            code={MOCK_DEVICE_CODES.expired}
            onNeedLogin={noop}
            onDone={noop}
          />
        </div>
        {[SAMPLE_LINK, MOCK_LINK.exhausted, MOCK_LINK.gone].map((linkId) => (
          <div key={linkId} className={frame}>
            <LinkPage
              linkId={linkId}
              fragment={FRAGMENT}
              onNeedLogin={noop}
              onJoined={noop}
              onDone={noop}
            />
          </div>
        ))}
      </div>
    </EmbeddedAuth.Provider>
  );
}

function CloudSamples({ session }: { session: ConsoleSession }) {
  const t = useT();
  const columns = useHostColumns();
  const [confirm, setConfirm] = React.useState(false);
  const [suspend, setSuspend] = React.useState(false);
  const actions = (row: CloudHostRow, layout: "table" | "list") => (
    <>
      {layout === "table" ? (
        <Button size="sm" variant="ghost">
          {t("showcase.cloud.open")}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="cluster"
            label={t("showcase.cloud.actionsFor", { name: row.name })}
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {layout === "list" ? (
            <DropdownMenuItem>{t("showcase.cloud.open")}</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive">
            {t("showcase.cloud.revoke")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const team = matchRoute("/t/rd/hosts")!;
  const personal = matchRoute("/me")!;
  const ops = matchRoute("/ops")!;
  const shellProps = {
    user: session.user,
    teams: session.teams,
    counts: CLOUD_COUNTS,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="h-[620px] overflow-hidden rounded-card border border-border">
        <ConsoleShell
          {...shellProps}
          match={team}
          onResendVerification={resend}
        >
          <PageHeader
            title={t("cloud.nav.hosts")}
            action={<Button>{t("showcase.cloud.register")}</Button>}
          />
          <DataList
            caption={t("showcase.cloud.hosts")}
            rows={CLOUD_HOSTS}
            columns={columns}
            rowKey={(row) => row.id}
            actions={actions}
            onRowOpen={noop}
          />
        </ConsoleShell>
      </div>

      <div className="flex flex-col gap-4">
        {[
          "/me",
          "/me/hosts",
          `/me/hosts/${MOCK_PERSONAL.linkHost}`,
          "/me/links",
          "/me/account",
          "/me/account?tab=devices",
        ].map((path) => {
          const match = matchRoute(...(path.split("?") as [string, string?]))!;
          return (
            <div
              key={path}
              className="h-[520px] overflow-hidden rounded-card border border-border"
            >
              <ConsoleShell {...shellProps} match={match}>
                <PersonalPage match={match} />
              </ConsoleShell>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-4">
        {["/ops", "/ops/nodes", "/ops/status"].map((path) => {
          const match = matchRoute(...(path.split("?") as [string, string?]));
          return (
            <div
              key={path}
              className="h-[420px] overflow-hidden rounded-card border border-border"
            >
              <ConsoleShell {...shellProps} match={match!} operator>
                <OpsPage match={match!} />
              </ConsoleShell>
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {[
          { match: personal, operator: false },
          { match: ops, operator: true },
        ].map(({ match, operator }) => (
          <div
            key={match.id}
            className="h-[460px] max-w-[280px] overflow-hidden rounded-card border border-border bg-panel"
          >
            <ConsoleSidebar {...shellProps} match={match} operator={operator} />
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <PageState
          code="internal"
          onRetry={noop}
          className="min-h-56 border border-dashed border-border"
        />
        <PageState
          code="forbidden"
          onHome={noop}
          className="min-h-56 border border-dashed border-border"
        />
        <PageState
          kind="notFound"
          onHome={noop}
          className="min-h-56 border border-dashed border-border"
        />
        <PageState
          kind="maintenance"
          onRetry={noop}
          className="min-h-56 border border-dashed border-border"
        />
        <PageState
          kind="sessionExpired"
          onSignIn={noop}
          className="min-h-56 border border-dashed border-border"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="hidden md:block">
          <DataList
            layout="table"
            caption={t("showcase.cloud.hosts")}
            rows={CLOUD_HOSTS.slice(0, 3)}
            columns={columns}
            rowKey={(row) => row.id}
            actions={actions}
            onRowOpen={noop}
          />
        </div>
        <div className="max-w-[390px]">
          <DataList
            layout="list"
            caption={t("showcase.cloud.hosts")}
            rows={CLOUD_HOSTS.slice(0, 3)}
            columns={columns}
            rowKey={(row) => row.id}
            actions={actions}
            onRowOpen={noop}
          />
        </div>
      </div>

      <PublicSamples />

      <div className="flex max-w-sm flex-col gap-4">
        {CLOUD_QUOTAS.map(({ tone, value }) => (
          <Progress
            key={tone}
            tone={tone}
            value={value}
            aria-label={t("showcase.cloud.quota")}
          />
        ))}
        <Button
          variant="outline"
          className="self-start"
          onClick={() => setConfirm(true)}
        >
          {t("showcase.cloud.deleteTeam")}
        </Button>
        <Button
          variant="destructive"
          className="self-start"
          onClick={() => setSuspend(true)}
        >
          {t("cloud.ops.suspend")}
        </Button>
      </div>
      <TypedConfirm
        open={suspend}
        reason
        onOpenChange={setSuspend}
        title={t("cloud.ops.suspendTitle", { name: CLOUD_TEAMS[0]!.name })}
        expected={CLOUD_TEAMS[0]!.name}
        actionLabel={t("cloud.ops.suspend")}
        onConfirm={noop}
      />
      <TypedConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={t("showcase.cloud.deleteTitle", { name: CLOUD_TEAMS[0]!.name })}
        expected={CLOUD_TEAMS[0]!.slug}
        actionLabel={t("showcase.cloud.deleteTeam")}
        onConfirm={noop}
      />
    </div>
  );
}
