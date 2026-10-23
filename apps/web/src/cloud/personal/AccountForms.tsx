import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { toast } from "@/ui/toast";
import { TurnstileWidget } from "../../challenge/TurnstileWidget";
import { TURNSTILE_PASSWORD_ACTION } from "../../challenge/turnstile";
import { useCloudApi } from "../api/context";
import { describeFailure, toCloudError } from "../api/errors";
import { useChangeEmail, useChangePassword } from "./account-data";

/** 一个必填口令 / 邮箱字段，错误贴在字段下（§3.0 表单）。 */
function TextField({
  label,
  error,
  inputRef,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "id"> & {
  label: string;
  error: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const id = React.useId();
  return (
    <Field data-invalid={error !== "" || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        ref={inputRef}
        aria-invalid={error !== "" || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

const isPasswordCode = (code: string) => code.startsWith("password_");

/** 更改口令：当前口令 + 新口令；成功后其他设备被退出，当前设备换新会话。 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const change = useChangePassword();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [errors, setErrors] = React.useState({ current: "", next: "" });
  const currentRef = React.useRef<HTMLInputElement>(null);
  const nextRef = React.useRef<HTMLInputElement>(null);
  // 人机挑战（platform.info.challenge.scope 含 auth.changePassword 时必带）；令牌一次性，每次失败换新的。
  const api = useCloudApi();
  const [siteKey, setSiteKey] = React.useState<string | null>(null);
  const [token, setToken] = React.useState("");
  const [widget, setWidget] = React.useState(0);
  const [challengeError, setChallengeError] = React.useState("");
  React.useEffect(() => {
    let live = true;
    api.client.platform.info({}).then(
      (info) => {
        if (live && info.challenge?.scope.includes("auth.changePassword"))
          setSiteKey(info.challenge.siteKey);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const submit = async () => {
    if (current === "" || next === "") {
      (current === "" ? currentRef : nextRef).current?.focus();
      return;
    }
    try {
      await change.mutateAsync({
        password: current,
        newPassword: next,
        ...(siteKey !== null && token !== ""
          ? { challenge: { provider: "turnstile" as const, token } }
          : {}),
      });
      toast.success(t("cloud.account.passwordChanged"));
      onClose();
    } catch (failure) {
      const { code } = toCloudError(failure);
      const message = describeFailure(failure);
      if (siteKey !== null) {
        setToken("");
        setWidget((n) => n + 1);
      }
      if (code === "challenge_required" || code === "challenge_invalid") {
        setErrors({ current: "", next: "" });
        setChallengeError(message);
      } else if (code === "credentials_invalid") {
        setErrors({ current: message, next: "" });
        currentRef.current?.focus();
      } else if (isPasswordCode(code)) {
        setErrors({ current: "", next: message });
        nextRef.current?.focus();
      } else toast.error(message);
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.account.changePassword")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <TextField
            label={t("cloud.account.currentPassword")}
            type="password"
            name="current-password"
            autoComplete="current-password"
            value={current}
            error={errors.current}
            inputRef={currentRef}
            onChange={(event) => {
              setCurrent(event.target.value);
              setErrors((previous) => ({ ...previous, current: "" }));
            }}
          />
          <TextField
            label={t("cloud.account.newPassword")}
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={next}
            error={errors.next}
            inputRef={nextRef}
            onChange={(event) => {
              setNext(event.target.value);
              setErrors((previous) => ({ ...previous, next: "" }));
            }}
          />
          {siteKey !== null ? (
            <Field data-invalid={challengeError !== "" || undefined}>
              <TurnstileWidget
                key={widget}
                siteKey={siteKey}
                action={TURNSTILE_PASSWORD_ACTION}
                onToken={(value) => {
                  setToken(value);
                  setChallengeError("");
                }}
                onError={() =>
                  setChallengeError(t("cloud.auth.challengeFailed"))
                }
              />
              {challengeError ? (
                <FieldError>{challengeError}</FieldError>
              ) : null}
            </Field>
          ) : null}
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={change.isPending}
              disabled={siteKey !== null && token === ""}
            >
              {t("cloud.common.save")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 更改邮箱：新邮箱 + 当前口令；新地址验证前旧邮箱照常生效，成功后由页面记下「待验证」。 */
export function ChangeEmailDialog({
  onClose,
  onRequested,
}: {
  onClose: () => void;
  onRequested: (email: string) => void;
}) {
  const t = useT();
  const change = useChangeEmail();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState({ email: "", password: "" });
  const emailRef = React.useRef<HTMLInputElement>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);

  const submit = async () => {
    const next = email.trim();
    if (next === "" || password === "") {
      (next === "" ? emailRef : passwordRef).current?.focus();
      return;
    }
    try {
      await change.mutateAsync({ newEmail: next, password });
      toast.success(t("cloud.account.emailSent", { email: next }));
      onRequested(next);
      onClose();
    } catch (failure) {
      const { code } = toCloudError(failure);
      const message = describeFailure(failure);
      if (code === "credentials_invalid") {
        setErrors({ email: "", password: message });
        passwordRef.current?.focus();
      } else if (code === "email_taken" || code === "bad_request") {
        setErrors({ email: message, password: "" });
        emailRef.current?.focus();
      } else toast.error(message);
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.account.changeEmail")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <TextField
            label={t("cloud.account.newEmail")}
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            error={errors.email}
            inputRef={emailRef}
            onChange={(event) => {
              setEmail(event.target.value);
              setErrors((previous) => ({ ...previous, email: "" }));
            }}
          />
          <TextField
            label={t("cloud.account.currentPassword")}
            type="password"
            name="current-password"
            autoComplete="current-password"
            value={password}
            error={errors.password}
            inputRef={passwordRef}
            onChange={(event) => {
              setPassword(event.target.value);
              setErrors((previous) => ({ ...previous, password: "" }));
            }}
          />
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button type="submit" loading={change.isPending}>
              {t("cloud.common.save")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
