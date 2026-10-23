import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { browserDevice } from "../../sources/cloud-client";
import { TurnstileWidget } from "../../challenge/TurnstileWidget";
import { TURNSTILE_LOGIN_ACTION } from "../../challenge/turnstile";
import { useCloudApi } from "../api/context";
import { describeFailure, toCloudError } from "../api/errors";
import { RouteLink } from "../RouteLink";
import { AuthLayout } from "./AuthLayout";

type Stage =
  | { kind: "credentials" }
  | { kind: "mfa"; challengeId: string; methods: readonly string[] };

/**
 * `/login`、`/login?scope=operator`：邮箱 + 口令，开了两步验证再走验证码 / 恢复码。
 * 成功后 `onSignedIn()`，由上层决定去哪（`next` 或空间概览）。
 */
export function LoginPage({
  operator,
  next,
  hash,
  onSignedIn,
}: {
  operator: boolean;
  /** 已过滤的站内落点。 */
  next: string | null;
  /** 邀请等带 `#` 令牌的落点要把片段带着走。 */
  hash: string;
  onSignedIn: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const [stage, setStage] = React.useState<Stage>({ kind: "credentials" });
  const [account, setAccount] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [siteKey, setSiteKey] = React.useState<string | null>(null);
  const [challenge, setChallenge] = React.useState("");
  const [widget, setWidget] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    api.client.platform.info({}).then(
      (info) => {
        if (live && info.challenge?.scope.includes("auth.login"))
          setSiteKey(info.challenge.siteKey);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const guarded = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (failure) {
      const code = toCloudError(failure).code;
      if (code === "challenge_required" || code === "challenge_invalid") {
        setChallenge("");
        setWidget((n) => n + 1);
      }
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    guarded(async () => {
      const answer = await api.client.auth.login({
        account: account.trim(),
        password,
        device: browserDevice(),
        ...(operator ? { scope: "operator" as const } : {}),
        ...(siteKey !== null && challenge !== ""
          ? { challenge: { provider: "turnstile" as const, token: challenge } }
          : {}),
      });
      setPassword("");
      if ("mfa" in answer) {
        setStage({
          kind: "mfa",
          challengeId: answer.mfa.challengeId,
          methods: answer.mfa.methods,
        });
        return;
      }
      onSignedIn();
    });

  const verify = (challengeId: string) =>
    guarded(async () => {
      await api.client.auth.mfaVerify({ challengeId, code: code.trim() });
      onSignedIn();
    });

  const query = new URLSearchParams();
  if (next !== null) query.set("next", next);
  const suffix = query.size === 0 ? "" : `?${query}`;

  if (stage.kind === "mfa") {
    const canRecover = stage.methods.includes("recovery");
    const canTotp = stage.methods.includes("totp");
    return (
      <AuthLayout title={t("auth.mfa.title")}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim() !== "") void verify(stage.challengeId);
          }}
        >
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor={`${id}-code`}>
              {recovery ? t("auth.mfa.recovery") : t("auth.mfa.code")}
            </FieldLabel>
            <Input
              id={`${id}-code`}
              autoFocus
              autoComplete="one-time-code"
              inputMode={recovery ? "text" : "numeric"}
              value={code}
              disabled={busy}
              aria-invalid={error !== "" || undefined}
              onChange={(event) => {
                setCode(event.target.value);
                setError("");
              }}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={code.trim() === ""}
            loading={busy}
          >
            {t("auth.verify")}
          </Button>
          {canRecover && canTotp && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRecovery(!recovery);
                setCode("");
                setError("");
              }}
            >
              {recovery ? t("auth.mfa.useTotp") : t("auth.mfa.useRecovery")}
            </Button>
          )}
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={operator ? t("cloud.auth.operatorTitle") : t("auth.title")}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (account.trim() !== "" && password !== "") void signIn();
        }}
      >
        <Field data-invalid={error !== "" || undefined}>
          <FieldLabel htmlFor={`${id}-account`}>
            {t("cloud.auth.email")}
          </FieldLabel>
          <Input
            id={`${id}-account`}
            type="email"
            name="email"
            autoFocus
            autoComplete="username"
            value={account}
            disabled={busy}
            onChange={(event) => {
              setAccount(event.target.value);
              setError("");
            }}
          />
        </Field>
        <Field data-invalid={error !== "" || undefined}>
          <FieldLabel htmlFor={`${id}-password`}>
            {t("auth.password")}
          </FieldLabel>
          <Input
            id={`${id}-password`}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            aria-invalid={error !== "" || undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setError("");
            }}
          />
          <FieldError>{error}</FieldError>
        </Field>
        {siteKey !== null && (
          <TurnstileWidget
            key={widget}
            siteKey={siteKey}
            action={TURNSTILE_LOGIN_ACTION}
            onToken={setChallenge}
            onError={() => setError(t("cloud.auth.challengeFailed"))}
          />
        )}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={
            account.trim() === "" ||
            password === "" ||
            (siteKey !== null && challenge === "")
          }
          loading={busy}
        >
          {t("auth.signIn")}
        </Button>
      </form>
      {!operator && (
        <div className="flex flex-col items-center gap-1">
          <Button asChild variant="link">
            <RouteLink href="/reset">{t("cloud.auth.forgot")}</RouteLink>
          </Button>
          <Button asChild variant="link">
            <RouteLink href={`/register${suffix}${hash}`}>
              {t("cloud.auth.toRegister")}
            </RouteLink>
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
