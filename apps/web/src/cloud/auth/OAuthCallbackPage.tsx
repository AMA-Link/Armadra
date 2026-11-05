import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { toast } from "@/ui/toast";
import { browserDevice } from "../../sources/cloud-client";
import { useCloudApi } from "../api/context";
import { CloudConsoleError, cloudMessage, toCloudError } from "../api/errors";
import { RouteLink } from "../RouteLink";
import { AuthLayout } from "./AuthLayout";
import { MfaStep } from "./MfaStep";
import {
  forgetOAuthIntent,
  leavePendingAction,
  recalledOAuthIntent,
  type OAuthIntent,
} from "./oauth-intent";
import { forgetOAuthNext, recalledOAuthNext } from "./redirect";
import { isOAuthProvider } from "./sign-in-options";

type Stage =
  | { kind: "working" }
  | { kind: "mfa"; challengeId: string; methods: readonly string[] }
  | { kind: "failed"; message: string; back: string | null };

/** 提供方回传的 `error=access_denied`（用户在授权页点了取消）。 */
const DENIED = "access_denied";

/** 失败 → 文案键；`null` 交给 {@link cloudMessage} 按码取。 */
function failureCopy(
  t: ReturnType<typeof useT>,
  failure: CloudConsoleError,
  intent: OAuthIntent | null = null,
): string {
  const details = failure.details as { reason?: unknown } | undefined;
  if (intent !== null) {
    if (failure.code === "conflict" && details?.reason === "identity_linked")
      return t("cloud.auth.oauthIdentityLinked");
    if (failure.code === "conflict" && details?.reason === "provider_linked")
      return t("cloud.auth.oauthProviderLinked");
    // state 失效、对不上，或提权窗口已过：回到原页面重新来。
    if (
      failure.code === "credentials_invalid" ||
      failure.code === "mfa_required"
    )
      return intent.purpose === "reauth"
        ? t("cloud.auth.oauthStepUpFailed")
        : t("cloud.auth.oauthLinkFailed");
  }
  if (failure.code === "conflict" && details?.reason === "account_exists")
    return t("cloud.auth.oauthAccountExists");
  // state 过期、用过或与发起的浏览器不符：重新来一遍。
  if (failure.code === "credentials_invalid")
    return t("cloud.auth.oauthExpired");
  if (failure.code === "not_found") return t("cloud.auth.oauthUnavailable");
  return cloudMessage(failure.code, failure.details, t) ?? t("error.internal");
}

/**
 * `/login/oauth/:provider`：提供方授权完回到这里（`?code=&state=` 或 `?error=`）。三种目的共用，
 * 跳走前存下的意图（`oauth-intent`）决定调哪个 finish，目的以服务端 state 为准：
 * 没有意图是登录（`auth.oauthFinish`，成功进存下的 `next`，缺省 `/me`，答两步验证挑战进第二步，
 * 失败显示文案和「返回登录」）；`reauth` 调 `auth.stepUp { oauth }` 后回原页面接着做；`link` 调
 * `auth.oauthLinkFinish` 后回原页面。`code`、`state` 读出来就从地址栏拿掉。
 */
export function OAuthCallbackPage({
  provider,
  search,
  onSignedIn,
}: {
  provider: string;
  search: URLSearchParams;
  /** 登录完成，去 `path`（缺省 `/me`）。 */
  onSignedIn: (path: string) => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const [stage, setStage] = React.useState<Stage>({ kind: "working" });
  // `state` 一次性：严格模式下效果会跑两遍，只发一次。
  const started = React.useRef(false);
  const landing = React.useRef<string | null>(null);

  const done = React.useCallback(() => {
    const path = landing.current ?? "/me";
    forgetOAuthNext();
    onSignedIn(path);
  }, [onSignedIn]);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = search.get("code") ?? "";
    const state = search.get("state") ?? "";
    const denied = search.get("error");
    const recalled = recalledOAuthIntent();
    forgetOAuthIntent();
    landing.current = recalledOAuthNext();
    // 一次性参数不留在地址栏、历史与分享里。
    window.history.replaceState(null, "", window.location.pathname);
    const back = recalled === null ? null : recalled.returnTo;
    if (!isOAuthProvider(provider)) {
      setStage({
        kind: "failed",
        message: t("cloud.auth.oauthUnavailable"),
        back,
      });
      return;
    }
    if (denied !== null) {
      setStage({
        kind: "failed",
        message:
          denied === DENIED
            ? t("cloud.auth.oauthCancelled")
            : t("error.internal"),
        back,
      });
      return;
    }
    if (code === "" || state === "") {
      setStage({
        kind: "failed",
        message: t("cloud.auth.oauthExpired"),
        back,
      });
      return;
    }
    if (recalled !== null && recalled.intent.provider === provider) {
      const { intent, returnTo, action } = recalled;
      const fail = (failure: unknown) =>
        setStage({
          kind: "failed",
          message: failureCopy(t, toCloudError(failure), intent),
          back: returnTo,
        });
      void (async () => {
        try {
          // 提权与绑定要有会话（Cookie 传输先取回 CSRF 值）。
          if (!(await api.ensureCsrf()))
            throw new CloudConsoleError("credentials_invalid", 401);
          if (intent.purpose === "reauth") {
            await api.client.auth.stepUp({ oauth: { provider, state, code } });
            // 回到原页面，由它接着做提权前要做的事。
            leavePendingAction(action);
          } else {
            await api.client.auth.oauthLinkFinish({ provider, state, code });
            toast.success(
              t("cloud.account.providerLinked", {
                provider: t(`cloud.account.provider.${provider}`),
              }),
            );
          }
          onSignedIn(returnTo);
        } catch (failure) {
          fail(failure);
        }
      })();
      return;
    }
    api.client.auth
      .oauthFinish({ provider, state, code, device: browserDevice() })
      .then(
        (answer) => {
          if ("mfa" in answer)
            setStage({
              kind: "mfa",
              challengeId: answer.mfa.challengeId,
              methods: answer.mfa.methods,
            });
          else done();
        },
        (failure: unknown) =>
          setStage({
            kind: "failed",
            message: failureCopy(t, toCloudError(failure)),
            back: null,
          }),
      );
  }, [api, provider, search, t, done, onSignedIn]);

  if (stage.kind === "mfa")
    return (
      <MfaStep
        challengeId={stage.challengeId}
        methods={stage.methods}
        onSignedIn={done}
      />
    );

  const next = recalledOAuthNext();
  return (
    <AuthLayout title={t("auth.title")}>
      {stage.kind === "working" ? (
        <div className="flex justify-center" aria-busy="true">
          <Spinner />
        </div>
      ) : (
        <>
          <Alert variant="destructive">
            <AlertTitle>{stage.message}</AlertTitle>
          </Alert>
          <Button asChild variant="outline" size="lg" className="w-full">
            <RouteLink
              href={
                stage.back !== null
                  ? stage.back
                  : next === null
                    ? "/login"
                    : `/login?next=${encodeURIComponent(next)}`
              }
            >
              {stage.back !== null
                ? t("cloud.auth.toAccount")
                : t("cloud.auth.toLogin")}
            </RouteLink>
          </Button>
        </>
      )}
    </AuthLayout>
  );
}
