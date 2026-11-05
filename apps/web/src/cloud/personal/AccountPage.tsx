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
import { useCloudApi } from "../api/context";
import { describeFailure, toCloudError } from "../api/errors";
import { oauthRedirectUri } from "../auth/OAuthButtons";
import { rememberOAuthIntent, takePendingAction } from "../auth/oauth-intent";
import { external } from "../auth/redirect";
import { isStepUpCancelled, useStepUp } from "../auth/StepUpDialog";
import { isOAuthProvider, useSignInOptions } from "../auth/sign-in-options";
import { navigate, type RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { InlineError } from "../ui/InlineError";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import { ChangeEmailDialog, ChangePasswordDialog } from "./AccountForms";
import {
  useChangeEmail,
  useDevices,
  useMe,
  useRenameAccount,
  useRevokeDevices,
  useSecurityLog,
  useSignInMethods,
  useUnlinkProvider,
  type Device,
  type LinkedProvider,
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
  const methods = useSignInMethods();
  const change = useChangeEmail();
  const step = useStepUp();
  const [name, setName] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState(false);

  // 提权要整页跳去提供方：回来后接着发出改邮箱的申请（一次性）。
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const action = takePendingAction(["emailChange"]);
    if (action === null) return;
    void (async () => {
      try {
        await step.run(
          () => change.mutateAsync({ newEmail: action.newEmail }),
          action,
        );
        toast.success(t("cloud.account.emailSent", { email: action.newEmail }));
        onPending(action.newEmail);
      } catch (failure) {
        if (!isStepUpCancelled(failure)) toast.error(describeFailure(failure));
      }
    })();
  }, [step, change, t, onPending]);

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
          // 取不到登录方式（旧服务端）按有口令处理。
          hasPassword={methods.data?.password ?? true}
          onClose={() => setDialog(false)}
          onRequested={onPending}
        />
      ) : null}
      {step.dialog}
    </>
  );
}

const SECURITY_PATH = "/me/account?tab=security";

/** 登录方式：每个开放的提供方一行，已绑的给登录名、邮箱与「解绑」，没绑的给「绑定」。 */
function SignInMethodsGroup() {
  const t = useT();
  const api = useCloudApi();
  const options = useSignInOptions();
  const methods = useSignInMethods();
  const unlink = useUnlinkProvider();
  const step = useStepUp();
  const [target, setTarget] = React.useState<LinkedProvider["provider"] | null>(
    null,
  );
  const lastTarget = React.useRef(target);
  if (target !== null) lastTarget.current = target;

  const startLink = React.useCallback(
    async (provider: LinkedProvider["provider"]) => {
      try {
        const answer = await step.run(
          () =>
            api.client.auth.oauthLinkStart({
              provider,
              redirectUri: oauthRedirectUri(provider),
            }),
          { kind: "linkProvider", provider },
        );
        rememberOAuthIntent({ purpose: "link", provider }, SECURITY_PATH);
        external.go(answer.authorizationUrl);
      } catch (failure) {
        if (!isStepUpCancelled(failure)) toast.error(describeFailure(failure));
      }
    },
    [api, step],
  );

  const doUnlink = React.useCallback(
    async (provider: LinkedProvider["provider"]) => {
      await step.run(() => unlink.mutateAsync(provider), {
        kind: "unlinkProvider",
        provider,
      });
      toast.success(
        t("cloud.account.providerUnlinked", {
          provider: t(`cloud.account.provider.${provider}`),
        }),
      );
    },
    [step, unlink, t],
  );

  // 提权要整页跳去提供方：回来后接着绑定 / 解绑（一次性）。
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const action = takePendingAction(["linkProvider", "unlinkProvider"]);
    if (action === null) return;
    if (action.kind === "linkProvider") void startLink(action.provider);
    else
      void doUnlink(action.provider).catch((failure: unknown) => {
        if (!isStepUpCancelled(failure)) toast.error(describeFailure(failure));
      });
  }, [startLink, doUnlink]);

  if (methods.isPending) return <SkeletonSettings rows={2} />;
  if (methods.isError)
    return (
      <InlineError
        error={methods.error}
        onRetry={() => void methods.refetch()}
      />
    );
  const linked = new Map(
    methods.data.providers.map((row) => [row.provider, row]),
  );
  // 开放的提供方，加上已绑但服务端已不再开放的。
  const shown = [
    ...new Set([
      ...options.providers,
      ...methods.data.providers.map((row) => row.provider),
    ]),
  ].filter(isOAuthProvider);
  if (shown.length === 0) return null;
  // 此刻能用的登录方式：口令，加上仍开放的已绑提供方；只剩一种时不许解绑它。
  const usable =
    (methods.data.password ? 1 : 0) +
    methods.data.providers.filter((row) =>
      (options.providers as readonly string[]).includes(row.provider),
    ).length;
  const shownTarget = lastTarget.current;

  return (
    <>
      <SettingsGroup title={t("cloud.account.signInMethods")}>
        {shown.map((provider) => {
          const row = linked.get(provider);
          const name = t(`cloud.account.provider.${provider}`);
          const isUsable = (options.providers as readonly string[]).includes(
            provider,
          );
          return (
            <SettingsRow key={provider} label={name}>
              {row ? (
                <>
                  <span
                    className="min-w-0 truncate text-muted-foreground"
                    translate="no"
                  >
                    {row.login ?? row.email}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isUsable && usable <= 1}
                    onClick={() => setTarget(provider)}
                  >
                    {t("cloud.account.unlink")}
                  </Button>
                </>
              ) : options.linkable ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void startLink(provider)}
                >
                  {t("cloud.account.link")}
                </Button>
              ) : null}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <ConfirmAction
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={
          shownTarget
            ? t("cloud.account.unlinkTitle", {
                provider: t(`cloud.account.provider.${shownTarget}`),
              })
            : ""
        }
        actionLabel={t("cloud.account.unlink")}
        consequence={t("cloud.account.unlinkConsequence")}
        onConfirm={async () => {
          if (!target) return;
          try {
            await doUnlink(target);
          } catch (failure) {
            if (!isStepUpCancelled(failure))
              toast.error(describeFailure(failure));
            throw failure;
          }
        }}
      />
      {step.dialog}
    </>
  );
}

function SecurityTab() {
  const t = useT();
  const options = useSignInOptions();
  const [dialog, setDialog] = React.useState(false);
  return (
    <div className="flex flex-col gap-6">
      {options.passwordChange ? (
        <SettingsGroup>
          <SettingsRow label={t("cloud.account.password")}>
            <Button variant="outline" size="sm" onClick={() => setDialog(true)}>
              {t("cloud.account.changePassword")}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      <SignInMethodsGroup />
      {dialog ? (
        <ChangePasswordDialog onClose={() => setDialog(false)} />
      ) : null}
    </div>
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
  const options = useSignInOptions();
  // 服务端既不报 `auth.password-change` 也不报 `auth.oauth-link`：安全页没有可放的，整页签收起。
  const tabs = TABS.filter(
    (entry) =>
      entry !== "security" ||
      options.loading ||
      options.passwordChange ||
      options.linkable,
  );
  const requested = match.query.get("tab");
  const tab: Tab = tabs.find((entry) => entry === requested) ?? "profile";

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
            {tabs.map((entry) => (
              <TabsTrigger key={entry} value={entry}>
                {t(TAB_KEY[entry])}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="profile">
          <ProfileTab pendingEmail={pendingEmail} onPending={setPendingEmail} />
        </TabsContent>
        {tabs.includes("security") && (
          <TabsContent value="security">
            <SecurityTab />
          </TabsContent>
        )}
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
