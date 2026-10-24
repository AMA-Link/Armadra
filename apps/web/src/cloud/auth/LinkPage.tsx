import * as React from "react";

import { type JoinLink, parseJoinLink } from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { localizedFailure } from "../../api/request";
import { LOCAL_SOURCE_ID } from "../../api/source";
import { TurnstileWidget } from "../../challenge/TurnstileWidget";
import {
  type CloudAccept,
  CloudTransportError,
  browserDevice,
  parseCloudAccept,
} from "../../sources/cloud-client";
import { startHostedRelay } from "../../sources/hosted";
import { openAfterJoin } from "../../sources/join-intent";
import { useCloudApi } from "../api/context";
import type { InvitationPreview } from "../api/session";
import {
  CloudConsoleError,
  describeFailure,
  toCloudError,
} from "../api/errors";
import { PageState } from "../ui/PageState";
import { AuthLayout } from "./AuthLayout";

/** 接受链接用的 Turnstile action（与中继的 `armadra-accept` 对应）。 */
const TURNSTILE_ACCEPT_ACTION = "armadra-accept";

/** 加入之后页面落在哪（托管页的根，与个人中转的 `JoinPage` 相同）。 */
const APP_PATH = "/app/";

const ROLES = new Set(["viewer", "editor", "operator", "driver"]);

type Info = Awaited<
  ReturnType<ReturnType<typeof useCloudApi>["client"]["links"]["get"]>
>;
type Stage =
  | { kind: "loading" }
  | { kind: "ready"; info: Info }
  | { kind: "failed"; message: string; code?: string };

/** 以访客加入（缺省经页面的托管中继；测试换掉）。 */
export type JoinWithAccept = (
  link: JoinLink,
  accepted: CloudAccept,
) => Promise<string>;

const hostedJoin: JoinWithAccept = (link, accepted) =>
  startHostedRelay({ issuer: link.issuer }).join(link, accepted);

/** 加入失败 → 界面那句：云端的码按控制台文案，中继与 core 那一段按个人中转的文案。 */
function failureText(failure: unknown, fallback: string): string {
  if (failure instanceof CloudConsoleError) return describeFailure(failure);
  if (failure instanceof CloudTransportError || failure instanceof TypeError)
    return localizedFailure("source_unreachable", fallback);
  const code = (failure as { code?: unknown } | null)?.code;
  return typeof code === "string" ? localizedFailure(code, fallback) : fallback;
}

/**
 * `/j/<linkId>#<秘密>.<邀请令牌>`（云端控制台 §3.1.6）：SaaS 云端托管的分享链接落地页。
 * 片段由 `PublicPage` 读入内存、从地址栏移除，所以穿过登录再回来也还在；这里只经 POST 交给
 * `links.accept`。团队设置要求登录（`requiresAccount` / `anonymous_links_disabled`）而没有会话，
 * 主按钮是「登录后加入」；其余是「加入」。带着会话接受，云端把使用记到账号上；接受后以访客
 * 经托管中继进画布（`onJoined`）。
 */
export function LinkPage({
  linkId,
  fragment,
  onNeedLogin,
  onJoined,
  onDone,
  join: joinWithAccept = hostedJoin,
}: {
  linkId: string;
  /** `#` 之后的 `<秘密>.<邀请令牌>[.<指纹>]`；没有是 `""`。 */
  fragment: string;
  /** 没有会话：上层保留片段、`replace` 跳 `/login?next=`。 */
  onNeedLogin: () => void;
  /** 加入成功、本机源已指到那台 core：换成画布。 */
  onJoined: () => void;
  onDone: () => void;
  join?: JoinWithAccept;
}) {
  const t = useT();
  const api = useCloudApi();
  const locale = usePreferencesStore((state) => state.locale);
  const [link] = React.useState<JoinLink | null>(() =>
    fragment === ""
      ? null
      : parseJoinLink(
          `${globalThis.location.origin}/j/${encodeURIComponent(linkId)}#${fragment}`,
        ),
  );
  const [stage, setStage] = React.useState<Stage>(
    link === null
      ? { kind: "failed", message: t("links.page.invalid") }
      : { kind: "loading" },
  );
  // 要不要登录才能加入、此刻有没有会话：先按摘要，接受时云端说了算。
  const [needAccount, setNeedAccount] = React.useState(false);
  const [signedIn, setSignedIn] = React.useState<boolean | null>(null);
  const [siteKey, setSiteKey] = React.useState<string | null>(null);
  const [challenge, setChallenge] = React.useState("");
  const [widget, setWidget] = React.useState(0);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // 接受过一次：重试只重跑加入。`links.accept` 会消耗次数，不能因为中继那一步失败就再接受一遍。
  const accepted = React.useRef<CloudAccept | null>(null);

  React.useEffect(() => {
    if (link === null) return;
    let live = true;
    api.client.links.get({ linkId }).then(
      async (info) => {
        if (!live) return;
        setNeedAccount(info.requiresAccount);
        if (info.requiresAccount) setSignedIn(await api.ensureCsrf());
        if (!live) return;
        setStage({ kind: "ready", info });
      },
      (failure: unknown) =>
        live &&
        setStage({
          kind: "failed",
          message: describeFailure(failure),
          code: toCloudError(failure).code,
        }),
    );
    api.client.platform.info({}).then(
      (info) => {
        if (live && info.challenge?.scope.includes("links.accept"))
          setSiteKey(info.challenge.siteKey);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, link, linkId]);

  const needsLogin = needAccount && signedIn !== true;

  const run = async () => {
    if (link === null || busy || stage.kind !== "ready") return;
    if (needsLogin) {
      onNeedLogin();
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 有会话就带着会话接受（写操作要 CSRF 值）；没有就是匿名访客。
      const session = await api.ensureCsrf();
      if (needAccount && !session) {
        setSignedIn(false);
        onNeedLogin();
        return;
      }
      if (accepted.current === null) {
        const answer = await api.client.links.accept({
          linkId,
          secret: link.secret,
          device: browserDevice(),
          ...(siteKey !== null && challenge !== ""
            ? {
                challenge: { provider: "turnstile" as const, token: challenge },
              }
            : {}),
        });
        if (stage.info.kind === "team_join") {
          onDone();
          return;
        }
        accepted.current = parseCloudAccept(answer);
      }
      await joinWithAccept(link, accepted.current);
      openAfterJoin(LOCAL_SOURCE_ID);
      try {
        // 与个人中转的落地页一致：换成托管页的根，刷新能续上（`/h/<源>` 的 SaaS 入口还没有）。
        globalThis.history.replaceState(null, "", APP_PATH);
      } catch {
        /* 地址栏停在 /j/ 也能用，只是刷新会回到落地页。 */
      }
      onJoined();
    } catch (failure) {
      // 挑战令牌一次性：任何一次失败都换新的。
      if (siteKey !== null) {
        setChallenge("");
        setWidget((n) => n + 1);
      }
      const failed = toCloudError(failure).code;
      if (failed === "link_frozen") {
        setStage({
          kind: "failed",
          message: describeFailure(failure),
          code: failed,
        });
        return;
      }
      if (failed === "anonymous_links_disabled") {
        setNeedAccount(true);
        setSignedIn(false);
        return;
      }
      setError(failureText(failure, t("links.page.failed")));
    } finally {
      setBusy(false);
    }
  };

  if (stage.kind === "loading")
    return (
      <AuthLayout title={t("links.page.title")}>
        <div
          role="status"
          aria-busy="true"
          aria-label={t("state.loading")}
          className="flex flex-col items-center gap-3"
        >
          <Skeleton className="h-[22px] w-40" />
          <Skeleton className="h-5 w-56" />
        </div>
      </AuthLayout>
    );

  if (stage.kind === "failed" && stage.code === "link_frozen")
    return (
      <main id="main" className="h-full overflow-y-auto bg-background">
        <PageState kind="forbidden" code="link_frozen" onHome={onDone} />
      </main>
    );

  if (stage.kind === "failed")
    return (
      <AuthLayout title={t("links.page.title")} subtitle={stage.message}>
        <Button size="lg" className="w-full" onClick={onDone}>
          {t("cloud.auth.continue")}
        </Button>
      </AuthLayout>
    );

  const { info } = stage;
  const name =
    info.kind === "team_join"
      ? t("cloud.auth.linkTeam", { name: info.teamName ?? info.label })
      : info.sourceName || info.label;
  const role =
    info.role !== undefined && ROLES.has(info.role)
      ? t(`sharing.role.${info.role}`)
      : "";
  const until =
    info.expiresAtMs > 0
      ? t("remote.invite.until", {
          time: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(info.expiresAtMs),
        })
      : "";
  const closed = info.exhausted ? localizedFailure("link_exhausted", "") : "";
  const verified = siteKey === null || challenge !== "";

  return (
    <AuthLayout title={t("links.page.title")} subtitle={name}>
      {(role !== "" || until !== "") && (
        <p className="flex flex-wrap items-center justify-center gap-2 text-body text-muted-foreground tabular-nums">
          {role !== "" && <Badge variant="outline">{role}</Badge>}
          {until}
        </p>
      )}
      {(closed !== "" || error !== "") && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{error || closed}</AlertTitle>
        </Alert>
      )}
      {siteKey !== null && !needsLogin && (
        <TurnstileWidget
          key={widget}
          siteKey={siteKey}
          action={TURNSTILE_ACCEPT_ACTION}
          onToken={setChallenge}
          onError={() => setError(t("cloud.auth.challengeFailed"))}
        />
      )}
      <Button
        size="lg"
        className="w-full"
        autoFocus
        disabled={
          info.exhausted ||
          (!needsLogin && !verified && accepted.current === null)
        }
        loading={busy}
        onClick={() => void run()}
      >
        {needsLogin
          ? t("cloud.auth.linkSignIn")
          : error !== "" && !busy
            ? t("links.page.retry")
            : t("cloud.auth.linkJoin")}
      </Button>
    </AuthLayout>
  );
}
