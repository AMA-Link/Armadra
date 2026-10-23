import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { useCloudApi } from "../api/context";
import { describeFailure, toCloudError } from "../api/errors";
import { RouteLink } from "../RouteLink";
import { AuthLayout } from "./AuthLayout";
import { fragmentToken, stripFragment } from "./redirect";

/**
 * `/reset`：没有令牌是「找回口令」（邮箱 → `auth.passwordResetStart`，总是答成功）；
 * `/reset#<令牌>` 是设新口令（`auth.passwordResetFinish`，成功后所有设备已撤，回登录）。
 */
export function ResetPage({ onSignIn }: { onSignIn: () => void }) {
  const [token] = React.useState(() => fragmentToken());
  React.useEffect(() => stripFragment(), []);
  return token === "" ? (
    <RequestReset />
  ) : (
    <FinishReset token={token} onSignIn={onSignIn} />
  );
}

function RequestReset() {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.client.auth.passwordResetStart({ email: email.trim() });
      setSent(true);
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t("cloud.auth.resetTitle")}
      {...(sent ? { subtitle: t("cloud.auth.resetSent") } : {})}
    >
      {!sent && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim() !== "") void submit();
          }}
        >
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor={`${id}-email`}>
              {t("cloud.auth.email")}
            </FieldLabel>
            <Input
              id={`${id}-email`}
              type="email"
              name="email"
              autoFocus
              autoComplete="username"
              value={email}
              disabled={busy}
              aria-invalid={error !== "" || undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setError("");
              }}
            />
            <FieldError>{error}</FieldError>
          </Field>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={email.trim() === ""}
            loading={busy}
          >
            {t("cloud.auth.resetSend")}
          </Button>
        </form>
      )}
      <Button asChild variant="link" className="self-center">
        <RouteLink href="/login">{t("auth.signIn")}</RouteLink>
      </Button>
    </AuthLayout>
  );
}

function FinishReset({
  token,
  onSignIn,
}: {
  token: string;
  onSignIn: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const [password, setPassword] = React.useState("");
  const [repeat, setRepeat] = React.useState("");
  const [error, setError] = React.useState("");
  const [mismatch, setMismatch] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<"ready" | "done" | "invalid">(
    "ready",
  );

  const submit = async () => {
    if (busy || !password || !repeat) return;
    if (password !== repeat) {
      setMismatch(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.client.auth.passwordResetFinish({
        token,
        newPassword: password,
      });
      setPassword("");
      setRepeat("");
      setStage("done");
    } catch (failure) {
      const code = toCloudError(failure).code;
      if (code === "email_token_invalid" || code === "email_token_expired") {
        setError(describeFailure(failure));
        setStage("invalid");
      } else setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  if (stage !== "ready")
    return (
      <AuthLayout
        title={stage === "done" ? t("reset.done") : t("reset.invalid")}
        {...(stage === "invalid" ? { subtitle: error } : {})}
      >
        {stage === "invalid" && (
          <Button asChild variant="outline" size="lg" className="w-full">
            <RouteLink href="/reset">{t("cloud.auth.resetTitle")}</RouteLink>
          </Button>
        )}
        <Button size="lg" className="w-full" autoFocus onClick={onSignIn}>
          {t("reset.signIn")}
        </Button>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("reset.title")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field data-invalid={error !== "" || undefined}>
          <FieldLabel htmlFor={`${id}-password`}>
            {t("reset.password")}
          </FieldLabel>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="new-password"
            autoFocus
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
        <Field data-invalid={mismatch || undefined}>
          <FieldLabel htmlFor={`${id}-repeat`}>{t("reset.repeat")}</FieldLabel>
          <Input
            id={`${id}-repeat`}
            type="password"
            autoComplete="new-password"
            value={repeat}
            disabled={busy}
            aria-invalid={mismatch || undefined}
            onChange={(event) => {
              setRepeat(event.target.value);
              setMismatch(false);
            }}
          />
          <FieldError>{mismatch ? t("reset.mismatch") : ""}</FieldError>
        </Field>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={!password || !repeat}
          loading={busy}
        >
          {t("reset.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
