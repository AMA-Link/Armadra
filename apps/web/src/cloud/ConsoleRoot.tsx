import * as React from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/app/preferences-store";
import { Toaster } from "@/ui/sonner";
import { toast } from "@/ui/toast";
import { CloudApiProvider, useCloudApi } from "./api/context";
import { createCloudApi } from "./api/client";
import { describeFailure, isSessionError, toCloudError } from "./api/errors";
import { cloudKeys } from "./api/keys";
import { createCloudQueryClient, useConsoleSession } from "./api/queries";
import type { CloudApi } from "./api/session";
import { PublicPage, hasPublicPage } from "./auth/PublicPage";
import { OpsPage } from "./ops/OpsPages";
import { navigate, useRoute, type RouteMatch } from "./router";
import { ConsoleShell } from "./shell/ConsoleShell";
import { PageHeader } from "./shell/PageHeader";
import {
  NAV,
  gate,
  goHome,
  rememberSpace,
  type ConsoleTeam,
  type ConsoleUser,
} from "./shell/model";
import { PageState } from "./ui/PageState";

export interface ConsoleSession {
  readonly user: ConsoleUser;
  readonly teams: readonly ConsoleTeam[];
  /** 有运营会话（独立登录，U8）；没有时 `/ops/*` 整页「找不到」。 */
  readonly operator?: boolean;
  /** 账号持有运营范围（`me.get.scopes`）：账号菜单里给「运营后台」，没有会话时它去运营登录。 */
  readonly operatorScope?: boolean;
  readonly counts?: Readonly<Record<string, number>>;
}

const NO_TEAMS: readonly ConsoleTeam[] = [];

/** 没有运营会话的运营账号从账号菜单进来：必须全新登录（云端控制台 §1.3）。 */
const OPERATOR_SIGN_IN = "/login?scope=operator&next=%2Fops";

/**
 * 地址 → 放行 → 外壳（云端控制台 §6.1）。会话由上层给；没有会话就是「登录已过期」。
 */
function ConsoleView({
  session,
  onSignOut,
  onResendVerification,
  renderPage,
  children,
}: {
  session: ConsoleSession | null;
  /** 当前页的内容；缺省（或答 `undefined`）只画页头。 */
  renderPage?: (match: RouteMatch) => React.ReactNode;
  onSignOut?: () => void;
  onResendVerification?: () => Promise<void>;
  /** 会话还没到时画在外壳之外的东西（加载、取会话失败）。 */
  children?: React.ReactNode;
}) {
  const t = useT();
  const match = useRoute();
  const teams = session?.teams ?? NO_TEAMS;
  const decision = session
    ? gate(match, { teams, operator: session.operator === true })
    : null;

  React.useEffect(() => {
    if (session && match?.area === "home") goHome(teams);
    else if (decision === "ok") rememberSpace(match);
  }, [session, match, decision, teams]);

  const home = () => navigate("/");
  if (
    session &&
    match &&
    match.area !== "public" &&
    match.area !== "home" &&
    decision === "ok"
  ) {
    const entry = NAV[match.area].find((row) => row.id === match.nav);
    return (
      <ConsoleShell
        user={session.user}
        teams={teams}
        match={match}
        {...(session.operator || session.operatorScope
          ? { operator: true }
          : {})}
        {...(session.operator ? {} : { operatorHref: OPERATOR_SIGN_IN })}
        {...(session.counts ? { counts: session.counts } : {})}
        {...(onSignOut ? { onSignOut } : {})}
        {...(onResendVerification ? { onResendVerification } : {})}
      >
        {renderPage?.(match) ?? (
          <PageHeader title={entry ? t(entry.labelKey) : ""} />
        )}
      </ConsoleShell>
    );
  }

  // 其余都是整页状态，不带侧栏。`/` 在跳转前什么也不画。
  let body: React.ReactNode = children ?? null;
  if (children !== undefined) {
    /* 会话还在取，或取失败：由上层给内容。 */
  } else if (!session) {
    const next = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    body =
      match === null || match.area === "public" ? (
        <PageState kind="notFound" onHome={home} />
      ) : (
        <PageState
          kind="sessionExpired"
          onSignIn={() => navigate(`/login?next=${next}`)}
        />
      );
  } else if (match?.area !== "home") {
    body =
      decision === "forbidden" ? (
        <PageState code="forbidden" onHome={home} />
      ) : (
        <PageState kind="notFound" onHome={home} />
      );
  }
  return (
    <main id="main" className="h-full overflow-y-auto bg-background">
      {body}
    </main>
  );
}

/* ------------------------------- 数据层 ------------------------------- */

/** 带数据的页面（要 `CloudApiProvider`，所以只在 `ConsoleData` 里接上）。 */
function renderPage(match: RouteMatch): React.ReactNode {
  return match.area === "ops" ? <OpsPage match={match} /> : undefined;
}

/** 用哪套客户端：调用方给的；DEV 且地址带 `?mock` 是内存 mock（生产构建里这支被摇掉）；否则连来源自己。 */
function useCloudApiSource(given?: CloudApi): CloudApi | null {
  const [api, setApi] = React.useState<CloudApi | null>(
    () =>
      given ??
      (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")
        ? null
        : createCloudApi({ origin: location.origin })),
  );
  React.useEffect(() => {
    if (api !== null) return;
    if (import.meta.env.DEV)
      void import("./mock/create-mock-client").then((mock) =>
        setApi(mock.createMockApi(mock.mockOptionsFromSearch(location.search))),
      );
  }, [api]);
  return api;
}

function ConsoleData({ onJoined }: { onJoined?: () => void }) {
  const api = useCloudApi();
  const client = useQueryClient();
  const [expired, setExpired] = React.useState(false);
  const match = useRoute();
  // 登录、注册、验证、找回、邀请不需要会话：不取，也不因为取不到而跳登录。
  const publicPage = hasPublicPage(match);
  const { session, error, loading, retry } = useConsoleSession({
    enabled: !expired && !publicPage,
  });
  const lost = !publicPage && (expired || isSessionError(error));

  // 运营会话过期或刷新页面后丢了内存里的 CSRF：账号有运营范围就先静默续，续不上去运营登录；
  // 没有运营范围的账号仍是「找不到」，不暴露这一区（云端控制台 §1.3、§1.4）。
  const wantsOps =
    match?.area === "ops" &&
    session !== undefined &&
    session !== null &&
    !session.operator &&
    session.operatorScope === true;
  const [opsRefresh, setOpsRefresh] = React.useState<"idle" | "failed">("idle");
  React.useEffect(() => {
    if (!wantsOps) {
      setOpsRefresh("idle");
      return;
    }
    let live = true;
    api.ops.auth.refresh({ scope: "operator" }).catch(() => {
      if (!live) return;
      setOpsRefresh("failed");
      const path = window.location.pathname + window.location.search;
      navigate(`/login?scope=operator&next=${encodeURIComponent(path)}`, {
        replace: true,
      });
    });
    return () => {
      live = false;
    };
  }, [wantsOps, api]);
  const recovering = wantsOps && opsRefresh === "idle";

  // 会话没了且续不上：回 `/login?next=<当前路径>`（云端控制台 §1.3）。
  React.useEffect(() => {
    if (!lost) return;
    const path = window.location.pathname + window.location.search;
    navigate(
      path === "/" ? "/login" : `/login?next=${encodeURIComponent(path)}`,
      {
        replace: true,
      },
    );
  }, [lost]);

  const finish = (path: string) => {
    client.removeQueries({ queryKey: cloudKeys.all });
    setExpired(false);
    navigate(path, { replace: true });
  };

  // 会话没了且续不上：清掉所有云端缓存，整页「登录已过期」。
  React.useEffect(
    () =>
      api.onSessionLost(() => {
        client.removeQueries({ queryKey: cloudKeys.all });
        setExpired(true);
      }),
    [api, client],
  );

  const signOut = () => {
    void api.signOut().finally(() => {
      client.removeQueries({ queryKey: cloudKeys.all });
      navigate("/login");
    });
  };
  const resend = async () => {
    try {
      await api.client.auth.emailVerifyResend({});
    } catch (failure) {
      toast.error(describeFailure(failure));
      throw failure;
    }
  };

  if (publicPage)
    return (
      <PublicPage
        match={match}
        finish={finish}
        {...(onJoined ? { onJoined } : {})}
      />
    );
  if (lost) return null;
  if (recovering)
    return (
      <ConsoleView session={null}>
        <div aria-busy="true" />
      </ConsoleView>
    );
  if (session)
    return (
      <ConsoleView
        session={session}
        renderPage={renderPage}
        onSignOut={signOut}
        onResendVerification={resend}
      />
    );
  return (
    <ConsoleView session={null}>
      {loading ? (
        <div aria-busy="true" />
      ) : (
        <PageState code={toCloudError(error).code} onRetry={retry} />
      )}
    </ConsoleView>
  );
}

/**
 * 控制台入口（云端控制台 §6.1）。给 `session` 就按它渲染（展示页与测试，不连数据）；
 * 否则装好 QueryClient 与客户端，用 `me.get` / `me.spaces` 取会话。
 */
export function ConsoleRoot({
  session,
  api: given,
  onJoined,
}: {
  session?: ConsoleSession | null;
  api?: CloudApi;
  /** `/j/` 的分享链接加入成功、画布接管（由入口给）。 */
  onJoined?: () => void;
}) {
  const api = useCloudApiSource(given);
  const [queryClient] = React.useState(createCloudQueryClient);
  if (session !== undefined) return <ConsoleView session={session} />;
  if (api === null) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <CloudApiProvider api={api}>
        <ConsoleData {...(onJoined ? { onJoined } : {})} />
        <Toaster />
      </CloudApiProvider>
    </QueryClientProvider>
  );
}

export default ConsoleRoot;
