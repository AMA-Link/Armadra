import * as React from "react";

import { syncDocumentPreferences, useT } from "@/app/preferences-store";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Spinner } from "@/ui/spinner";
import { LOCAL_SOURCE_ID } from "../../api/source";
import {
  type ConsoleHost,
  type HostView,
  HOST_FAILURE,
  consoleHost,
  startConsoleHost,
} from "../../sources/console-host";
import { openWhenReady } from "../../sources/join-intent";
import { createCloudApi } from "../api/client";
import { AuthLayout } from "../auth/AuthLayout";

/**
 * 控制台的 `/h/<hostId>`（设计 saas-host-open §2.1）：进主机之前是控制台公开页同款的居中
 * 卡片（连接中、离线、失败）；进去之后渲染画布（`children`），顶上一条主机名、「控制台」与
 * 「登出」。进去之后的掉线、登出、Cookie 过期盖一层状态卡，画布不卸载。
 */

function useHost(host: ConsoleHost) {
  return React.useSyncExternalStore(
    host.subscribe,
    () => host.view,
    () => host.view,
  );
}

/** 失败之后回哪儿。 */
function homeOf(host: ConsoleHost, code: string): string {
  if (code === HOST_FAILURE.unlinked) return host.info?.consoleHref ?? "/";
  if (code === HOST_FAILURE.teamSuspended) return "/";
  return host.info?.space === "team"
    ? host.info.consoleHref.replace(/\/hosts\/.*$/, "/hosts")
    : "/me/hosts";
}

/** 本机认不了你的账号、或认你作成员：在主机上补登录（§2.6）。 */
function FixCommand({ issuer }: { issuer: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 text-meta">
      <p>{t("cloud.host.fixServer")}</p>
      <code className="rounded-control bg-muted px-2 py-1 font-mono break-all select-all">
        {`armadra-server cloud login --issuer ${issuer}`}
      </code>
      <p className="text-muted-foreground">{t("cloud.host.fixDesktop")}</p>
    </div>
  );
}

function StateCard({ host, view }: { host: ConsoleHost; view: HostView }) {
  const t = useT();
  const name = host.info?.name ?? "";
  if (view.kind === "connecting" || view.kind === "login")
    return (
      <AuthLayout
        title={
          name
            ? t("cloud.host.connecting", { name })
            : t("cloud.host.connectingUnnamed")
        }
        {...(view.kind === "connecting" && view.rateLimited
          ? { subtitle: t("cloud.host.rateLimited") }
          : {})}
      >
        <div className="flex justify-center" aria-busy="true">
          <Spinner />
        </div>
      </AuthLayout>
    );
  if (view.kind === "offline")
    return (
      <AuthLayout
        title={t("cloud.host.offline", { name })}
        subtitle={t("cloud.host.offlineHint")}
      />
    );
  if (view.kind === "signedOut")
    return (
      <AuthLayout title={t("cloud.host.signedOut")}>
        <div className="flex flex-col gap-2">
          <Button onClick={() => window.location.reload()}>
            {t("cloud.host.reopen")}
          </Button>
          <Button variant="ghost" asChild>
            <a href={host.info?.consoleHref ?? "/"}>
              {t("cloud.host.console")}
            </a>
          </Button>
        </div>
      </AuthLayout>
    );
  if (view.kind === "expired")
    return (
      <AuthLayout title={t("cloud.host.expired")}>
        <Button asChild>
          <a
            href={`/login?next=${encodeURIComponent(`/h/${host.hostId}`)}`}
            target="_blank"
            rel="noopener"
          >
            {t("cloud.host.signIn")}
          </a>
        </Button>
      </AuthLayout>
    );
  if (view.kind !== "failed") return null;
  const home = homeOf(host, view.code);
  return (
    <AuthLayout title={t(`cloud.host.error.${view.code}`)}>
      {view.code === HOST_FAILURE.unlinked && (
        <FixCommand issuer={host.issuer} />
      )}
      {view.fingerprint !== undefined && (
        <p className="text-center text-meta text-muted-foreground">
          {t("cloud.host.fingerprint", {
            fingerprint: view.fingerprint.replace(/(.{4})(?=.)/g, "$1 "),
          })}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {(view.code === HOST_FAILURE.deviceUnavailable ||
          view.code === HOST_FAILURE.failed) && (
          <Button onClick={() => void host.open()}>
            {t("cloud.common.retry")}
          </Button>
        )}
        <Button variant="ghost" asChild>
          <a href={home}>
            {view.code === HOST_FAILURE.teamSuspended
              ? t("cloud.host.backToOverview")
              : view.code === HOST_FAILURE.unlinked
                ? t("cloud.host.backToHost")
                : t("cloud.host.backToHosts")}
          </a>
        </Button>
      </div>
    </AuthLayout>
  );
}

/** 进去之后的顶栏：主机名、主人映射提示、「控制台」、「登出」。 */
function HostBar({ host }: { host: ConsoleHost }) {
  const t = useT();
  return (
    <div
      data-slot="host-bar"
      className="flex min-h-8 items-center gap-2 border-b bg-background pt-[var(--safe-top)] pr-3 pl-12 text-caption"
    >
      <span className="min-w-0 flex-1 truncate font-medium">
        {host.info?.name}
      </span>
      {host.ownerMismatch && (
        <Popover>
          <span className="truncate text-muted-foreground">
            {t("cloud.host.memberNotOwner")}
          </span>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost">
              {t("cloud.host.howToFix")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <FixCommand issuer={host.issuer} />
          </PopoverContent>
        </Popover>
      )}
      <Button size="sm" variant="ghost" asChild>
        <a href={host.info?.consoleHref ?? "/"}>{t("cloud.host.console")}</a>
      </Button>
      <Button size="sm" variant="outline" onClick={() => void host.signOut()}>
        {t("cloud.host.signOut")}
      </Button>
    </div>
  );
}

export function HostRoot({
  hostId,
  workspaceId,
  host: given,
  children,
}: {
  hostId: string;
  workspaceId?: string;
  /** 测试注入；缺省按页面来源建一个。 */
  host?: ConsoleHost;
  children: React.ReactNode;
}) {
  const [host] = React.useState(
    () =>
      given ??
      consoleHost() ??
      startConsoleHost({
        hostId,
        issuer: window.location.origin,
        client: createCloudApi({ origin: window.location.origin }).client,
      }),
  );
  const t = useT();
  const view = useHost(host);
  const [entered, setEntered] = React.useState(false);

  React.useEffect(() => {
    void host.open();
  }, [host]);

  React.useEffect(() => {
    if (view.kind === "login") {
      window.location.replace(
        `/login?next=${encodeURIComponent(`/h/${hostId}`)}`,
      );
      return;
    }
    if (view.kind !== "entered" || entered) return;
    setEntered(true);
    // `?ws=`：进去后打开那个工作空间，并从地址栏抹掉参数。
    if (workspaceId !== undefined) {
      openWhenReady(LOCAL_SOURCE_ID, workspaceId);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [view, entered, hostId, workspaceId]);

  // 进画布之前自己跟上明暗与语言（画布挂上后交还给 App）。
  React.useEffect(
    () => (entered ? undefined : syncDocumentPreferences()),
    [entered],
  );

  // 回到这个标签页（另开的标签里重新登录了）：Cookie 过期的那层重试一次。
  React.useEffect(() => {
    if (view.kind !== "expired") return;
    const retry = () => {
      if (document.visibilityState === "visible") void host.open();
    };
    document.addEventListener("visibilitychange", retry);
    return () => document.removeEventListener("visibilitychange", retry);
  }, [view, host]);

  // 没进去过、或已经登出（会话没了，画布与它的对话框都不该再留着）：整页状态卡。
  if (!entered || view.kind === "signedOut")
    return <StateCard host={host} view={view} />;
  const covered = view.kind !== "entered";
  return (
    <div className="relative flex h-dvh flex-col">
      <HostBar host={host} />
      <div className="min-h-0 flex-1" inert={covered}>
        {children}
      </div>
      {covered && (
        <div
          data-slot="host-cover"
          className="absolute inset-0 z-50 bg-background/90"
        >
          {view.kind === "offline" ? (
            <Alert className="mx-auto mt-16 max-w-sm">
              <AlertTitle>
                {t("cloud.host.offline", { name: host.info?.name ?? "" })}
              </AlertTitle>
              <AlertDescription>{t("cloud.host.offlineHint")}</AlertDescription>
            </Alert>
          ) : (
            <StateCard host={host} view={view} />
          )}
        </div>
      )}
    </div>
  );
}

export default HostRoot;
