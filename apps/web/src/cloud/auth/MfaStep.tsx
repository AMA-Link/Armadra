import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { useCloudApi } from "../api/context";
import { describeFailure } from "../api/errors";
import { AuthLayout } from "./AuthLayout";

/**
 * 登录的第二步（两步验证）：6 位验证码，或恢复码。口令登录与第三方登录回跳共用；
 * 成功后 `onSignedIn()`。
 */
export function MfaStep({
  operator = false,
  challengeId,
  methods,
  onSignedIn,
}: {
  operator?: boolean;
  challengeId: string;
  methods: readonly string[];
  onSignedIn: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const [code, setCode] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const canRecover = methods.includes("recovery");
  const canTotp = methods.includes("totp");

  const verify = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await (operator ? api.ops : api.client).auth.mfaVerify({
        challengeId,
        code: code.trim(),
      });
      onSignedIn();
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("auth.mfa.title")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim() !== "") void verify();
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
