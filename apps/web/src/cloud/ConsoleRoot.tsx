import * as React from "react";

import { useT } from "@/app/preferences-store";
import { navigate, useRoute } from "./router";
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
  readonly counts?: Readonly<Record<string, number>>;
}

const NO_TEAMS: readonly ConsoleTeam[] = [];

/**
 * 控制台入口（云端控制台 §6.1）：地址 → 放行 → 外壳。数据层还没接（U1b），
 * 会话由调用方给；没有会话就是「登录已过期」。
 */
export function ConsoleRoot({ session }: { session?: ConsoleSession | null }) {
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
        {...(session.operator ? { operator: true } : {})}
        {...(session.counts ? { counts: session.counts } : {})}
      >
        <PageHeader title={entry ? t(entry.labelKey) : ""} />
      </ConsoleShell>
    );
  }

  // 其余都是整页状态，不带侧栏。`/` 在跳转前什么也不画。
  let body: React.ReactNode = null;
  if (!session) {
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

export default ConsoleRoot;
