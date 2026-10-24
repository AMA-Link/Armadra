import * as React from "react";
import { Globe, Monitor, Server, Smartphone } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { SkeletonSettings, SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { navigate, type RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { InlineError } from "../ui/InlineError";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import { ChangeEmailDialog, ChangePasswordDialog } from "./AccountForms";
import {
  useDevices,
  useMe,
  useRenameAccount,
  useRevokeDevices,
  useSecurityLog,
  type Device,
  type SecurityEvent,
} from "./account-data";

const TABS = ["profile", "security", "devices", "log"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, string> = {
  profile: "cloud.account.profile",
  security: "cloud.account.security",
  devices: "cloud.account.devices",
  log: "cloud.account.securityLog",
};

const PLATFORM_ICON = {
  ios: Smartphone,
  android: Smartphone,
  desktop: Monitor,
  browser: Globe,
  server: Server,
} as const;

function ProfileTab({
  pendingEmail,
  onPending,
}: {
  pendingEmail: string | null;
  onPending: (email: string) => void;
}) {
  const t = useT();
  const me = useMe();
  const rename = useRenameAccount();
  const [name, setName] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState(false);

  if (me.isPending) return <SkeletonSettings rows={2} />;
  if (me.isError)
    return <InlineError error={me.error} onRetry={() => void me.refetch()} />;
  const shown = name ?? me.data.displayName;
  const save = async () => {
    const next = shown.trim();
    setName(null);
    if (next === "" || next === me.data.displayName) return;
    try {
      await rename.mutateAsync(next);
      toast.success(t("cloud.common.saved"));
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("cloud.account.name")}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              aria-label={t("cloud.account.name")}
              value={shown}
              maxLength={128}
              autoComplete="name"
              className="w-56 max-w-full"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void save()}
            />
          </form>
        </SettingsRow>
        <SettingsRow label={t("cloud.account.email")}>
          <span
            className="min-w-0 truncate text-muted-foreground"
            translate="no"
          >
            {me.data.email}
          </span>
          {pendingEmail ? (
            <Badge variant="outline" translate="no">
              {t("cloud.account.emailPending", { email: pendingEmail })}
            </Badge>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setDialog(true)}>
            {t("cloud.account.changeEmail")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      {dialog ? (
        <ChangeEmailDialog
          onClose={() => setDialog(false)}
          onRequested={onPending}
        />
      ) : null}
    </>
  );
}

function SecurityTab() {
  const t = useT();
  const [dialog, setDialog] = React.useState(false);
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("cloud.account.password")}>
          <Button variant="outline" size="sm" onClick={() => setDialog(true)}>
            {t("cloud.account.changePassword")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      {dialog ? (
        <ChangePasswordDialog onClose={() => setDialog(false)} />
      ) : null}
    </>
  );
}

function DevicesTab() {
  const t = useT();
  const devices = useDevices();
  const revoke = useRevokeDevices();
  const [target, setTarget] = React.useState<Device | "others" | null>(null);
  // 关闭确认框的动画里 target 已是 null：标题用最后一个，免得闪空。
  const lastTarget = React.useRef(target);
  if (target !== null) lastTarget.current = target;

  const columns = React.useMemo<DataColumn<Device>[]>(
    () => [
      {
        id: "device",
        header: t("cloud.account.device"),
        role: "primary",
        cell: (row) => {
          const Icon = PLATFORM_ICON[row.platform];
          return (
            <span className="flex min-w-0 items-center gap-2">
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate" translate="no">
                {row.name}
              </span>
              {row.current ? (
                <Badge variant="secondary">{t("cloud.account.current")}</Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "platform",
        header: t("cloud.account.platform"),
        cell: (row) => t(`cloud.account.platform.${row.platform}`),
      },
      {
        id: "lastUsed",
        header: t("cloud.account.lastUsed"),
        cell: (row) =>
          row.lastSeenAtMs === null ? null : (
            <RelativeTime ms={row.lastSeenAtMs} />
          ),
      },
    ],
    [t],
  );

  if (devices.isPending)
    return (
      <SkeletonTable rows={3} columns={3} label={t("cloud.account.devices")} />
    );
  if (devices.isError)
    return (
      <InlineError
        error={devices.error}
        onRetry={() => void devices.refetch()}
      />
    );
  // 当前设备排第一。
  const rows = [...devices.data.devices].sort(
    (a, b) => Number(b.current) - Number(a.current),
  );
  const others = rows.filter((row) => !row.current);
  const shown = lastTarget.current;
  const confirmTitle =
    shown === "others"
      ? t("cloud.account.signOutOthersTitle")
      : shown
        ? t("cloud.account.signOutTitle", { name: shown.name })
        : "";

  return (
    <div className="flex flex-col gap-4">
      <DataList
        caption={t("cloud.account.devices")}
        rows={rows}
        columns={columns}
        rowKey={(row) => row.deviceId}
        actionsHeader={t("cloud.account.signOut")}
        actions={(row) =>
          row.current ? null : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("cloud.account.signOutNamed", { name: row.name })}
              onClick={() => setTarget(row)}
            >
              {t("cloud.account.signOut")}
            </Button>
          )
        }
      />
      {others.length > 0 ? (
        <Button
          variant="destructive"
          className="self-start"
          onClick={() => setTarget("others")}
        >
          {t("cloud.account.signOutOthers")}
        </Button>
      ) : null}
      <ConfirmAction
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={confirmTitle}
        actionLabel={t("cloud.account.signOut")}
        onConfirm={async () => {
          if (!target) return;
          const ids =
            target === "others"
              ? others.map((row) => row.deviceId)
              : [target.deviceId];
          try {
            await revoke.mutateAsync(ids);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.account.signedOut"));
        }}
      />
    </div>
  );
}

function useEventLabel() {
  const t = useT();
  return (action: string) => {
    const key = `cloud.account.event.${action.replace(/^security\./, "")}`;
    const label = t(key);
    return label === key ? action : label;
  };
}

function LogTab() {
  const t = useT();
  const log = useSecurityLog();
  const label = useEventLabel();
  const rows = React.useMemo(
    () => log.data?.pages.flatMap((page) => page.events) ?? [],
    [log.data],
  );
  const columns = React.useMemo<DataColumn<SecurityEvent>[]>(
    () => [
      {
        id: "event",
        header: t("cloud.account.event"),
        role: "primary",
        cell: (row) => label(row.action),
      },
      {
        id: "time",
        header: t("cloud.account.time"),
        cell: (row) => <RelativeTime ms={row.atMs} />,
      },
      {
        id: "device",
        header: t("cloud.account.device"),
        cell: (row) =>
          row.deviceName ? <span translate="no">{row.deviceName}</span> : null,
      },
      {
        id: "ip",
        header: t("cloud.account.ipPrefix"),
        cell: (row) =>
          row.ipPrefix ? <span translate="no">{row.ipPrefix}</span> : null,
      },
    ],
    [t, label],
  );

  if (log.isPending)
    return (
      <SkeletonTable
        rows={4}
        columns={4}
        label={t("cloud.account.securityLog")}
      />
    );
  if (log.isError)
    return <InlineError error={log.error} onRetry={() => void log.refetch()} />;
  if (rows.length === 0)
    return <EmptyState title={t("cloud.account.logEmpty")} />;
  return (
    <div className="flex flex-col gap-4">
      <DataList
        caption={t("cloud.account.securityLog")}
        rows={rows}
        columns={columns}
        rowKey={(row) => row.eventId}
      />
      {log.hasNextPage ? (
        <Button
          variant="outline"
          className="self-start"
          loading={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t("cloud.common.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}

/** 个人 · 账号 `/me/account`（云端控制台 §3.2.5，M1）：资料 · 安全 · 设备 · 安全日志，`?tab=` 进地址。 */
export function AccountPage({ match }: { match: RouteMatch }) {
  const t = useT();
  const me = useMe();
  const [pendingEmail, setPendingEmail] = React.useState<string | null>(null);
  const requested = match.query.get("tab");
  const tab: Tab = TABS.find((entry) => entry === requested) ?? "profile";

  // 页签里的取数失败各自画区块内错误；连账号都取不到才是整页。
  if (me.isError && !me.data)
    return (
      <>
        <PageHeader title={t("cloud.nav.account")} />
        <PageState
          code={toCloudError(me.error).code}
          onRetry={() => void me.refetch()}
          onHome={() => navigate("/me")}
        />
      </>
    );
  return (
    <>
      <PageHeader title={t("cloud.nav.account")} />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const params = new URLSearchParams(window.location.search);
          params.set("tab", value);
          navigate(`${window.location.pathname}?${params}`, { replace: true });
        }}
      >
        <div className="mb-4 overflow-x-auto [scrollbar-width:none]">
          <TabsList variant="line">
            {TABS.map((entry) => (
              <TabsTrigger key={entry} value={entry}>
                {t(TAB_KEY[entry])}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="profile">
          <ProfileTab pendingEmail={pendingEmail} onPending={setPendingEmail} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="devices">
          <DevicesTab />
        </TabsContent>
        <TabsContent value="log">
          <LogTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
