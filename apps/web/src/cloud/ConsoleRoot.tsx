import * as React from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/app/preferences-store";
import { Toaster } from "@/ui/sonner";
import { toast } from "@/ui/toast";
import { CloudApiProvider, useCloudApi } from "./api/context";
import { createCloudApi } from "./api/client";
import { describeFailure, isSessionError, toCloudError } from "./api/errors";
import { cloudKeys } from "./api/keys";
import { applyMeStreamEvent, resyncCloudQueries } from "./api/stream";
import { createCloudQueryClient, useConsoleSession } from "./api/queries";
import type { CloudApi } from "./api/session";
import { PublicPage, hasPublicPage } from "./auth/PublicPage";
import { OpsPage } from "./ops/OpsPages";
import { PersonalPage } from "./personal/PersonalPages";
import { CreateTeamDialog } from "./team/CreateTeamDialog";
import { DeletedTeamPage } from "./team/DeletedTeamPage";
import { TeamPage } from "./team/TeamPage";
import { EndorserProvider, type HostEndorser } from "./trust/endorser";
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
  renderCreateTeam,
  renderMissingTeam,
  children,
}: {
  session: ConsoleSession | null;
  /** 当前页的内容；缺省（或答 `undefined`）只画页头。 */
  renderPage?: (match: RouteMatch) => React.ReactNode;
  /** 「创建团队」对话框；没给（没有数据层）空间菜单里就没有这一项。 */
  renderCreateTeam?: (close: () => void) => React.ReactNode;
  /** 地址里的团队不在空间列表里时画什么（恢复期内的团队）；答 `undefined` 就是「找不到」。 */
  renderMissingTeam?: (match: RouteMatch) => React.ReactNode;
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

  const [creating, setCreating] = React.useState(false);
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
        {...(renderCreateTeam ? { onCreateTeam: () => setCreating(true) } : {})}
      >
        {renderPage?.(match) ?? (
          <PageHeader title={entry ? t(entry.labelKey) : ""} />
        )}
        {creating ? renderCreateTeam?.(() => setCreating(false)) : null}
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
    const missingTeam =
      decision === "notFound" && match?.area === "team"
        ? renderMissingTeam?.(match)
        : undefined;
    body =
      decision === "forbidden" ? (
        <PageState code="forbidden" onHome={home} />
      ) : (
        (missingTeam ?? <PageState kind="notFound" onHome={home} />)
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
  if (match.area === "ops") return <OpsPage match={match} />;
  if (match.area === "personal") return <PersonalPage match={match} />;
  if (match.area === "team") return <TeamPage match={match} />;
  return undefined;
}

const renderCreateTeam = (close: () => void) => (
  <CreateTeamDialog onClose={close} />
);

const renderMissingTeam = (match: RouteMatch) =>
  match.params.team ? <DeletedTeamPage slug={match.params.team} /> : undefined;

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

  // 有会话就连 me-stream：上下线就地改缓存，其余事件让对应的键过期重拉（§6.2）。
  const signedIn = session !== null && !lost;
  React.useEffect(() => {
    if (!signedIn) return;
    return api.stream({
      onEvent: (event) => applyMeStreamEvent(client, event),
      onResync: () => resyncCloudQueries(client),
    });
  }, [api, client, signedIn]);

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
        renderCreateTeam={renderCreateTeam}
        renderMissingTeam={renderMissingTeam}
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
  endorser = null,
  onJoined,
}: {
  session?: ConsoleSession | null;
  api?: CloudApi;
  /** 端到端背书（设备信任页）；没有就一律「在已信任的设备上处理」。 */
  endorser?: HostEndorser | null;
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
        <EndorserProvider endorser={endorser}>
          <ConsoleData {...(onJoined ? { onJoined } : {})} />
        </EndorserProvider>
        <Toaster />
      </CloudApiProvider>
    </QueryClientProvider>
  );
}

export default ConsoleRoot;
