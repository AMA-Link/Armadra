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

  const submit = async () => {
    if (current === "" || next === "") {
      (current === "" ? currentRef : nextRef).current?.focus();
      return;
    }
    try {
      await change.mutateAsync({ password: current, newPassword: next });
      toast.success(t("cloud.account.passwordChanged"));
      onClose();
    } catch (failure) {
      const { code } = toCloudError(failure);
      const message = describeFailure(failure);
      if (code === "credentials_invalid") {
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
