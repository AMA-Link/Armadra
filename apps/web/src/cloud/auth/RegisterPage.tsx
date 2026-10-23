import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { browserDevice } from "../../sources/cloud-client";
import { useCloudApi } from "../api/context";
import { describeFailure } from "../api/errors";
import { RouteLink } from "../RouteLink";
import { AuthLayout } from "./AuthLayout";

/** `/register`：邮箱、名称、口令；暂停注册（`platform.info.registrationsOpen = false`）时只给登录入口。 */
export function RegisterPage({
  next,
  onSignedIn,
}: {
  next: string | null;
  onSignedIn: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    api.client.platform.info({}).then(
      (info) => {
        if (live && info.registrationsOpen === false) setOpen(false);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const query = next === null ? "" : `?next=${encodeURIComponent(next)}`;
  const signInLink = (
    <Button asChild variant="link" className="self-center">
      <RouteLink href={`/login${query}`}>{t("cloud.auth.toSignIn")}</RouteLink>
    </Button>
  );

  if (!open)
    return (
      <AuthLayout
        title={t("cloud.auth.registerTitle")}
        subtitle={t("cloud.auth.registrationsClosed")}
      >
        {signInLink}
      </AuthLayout>
    );

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.client.auth.register({
        email: email.trim(),
        password,
        displayName: name.trim(),
        device: browserDevice(),
      });
      setPassword("");
      onSignedIn();
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  const ready = email.trim() !== "" && name.trim() !== "" && password !== "";
  const field = (
    key: string,
    label: string,
    value: string,
    set: (value: string) => void,
    props: React.ComponentProps<typeof Input>,
    message = "",
  ) => (
    <Field data-invalid={message !== "" || undefined}>
      <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
      <Input
        id={`${id}-${key}`}
        value={value}
        disabled={busy}
        aria-invalid={message !== "" || undefined}
        onChange={(event) => {
          set(event.target.value);
          setError("");
        }}
        {...props}
      />
      <FieldError>{message}</FieldError>
    </Field>
  );

  return (
    <AuthLayout title={t("cloud.auth.registerTitle")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void submit();
        }}
      >
        {field("email", t("cloud.auth.email"), email, setEmail, {
          type: "email",
          name: "email",
          autoFocus: true,
          autoComplete: "username",
        })}
        {field("name", t("cloud.auth.name"), name, setName, {
          name: "name",
          autoComplete: "name",
          maxLength: 128,
        })}
        {field(
          "password",
          t("auth.password"),
          password,
          setPassword,
          { type: "password", name: "password", autoComplete: "new-password" },
          error,
        )}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={!ready}
          loading={busy}
        >
          {t("cloud.auth.register")}
        </Button>
      </form>
      {signInLink}
    </AuthLayout>
  );
}
