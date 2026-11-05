import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { useCloudApi } from "../api/context";
import { describeFailure, toCloudError } from "../api/errors";
import { useQuery } from "@tanstack/react-query";
import { signInMethodsQuery } from "../api/queries";
import { oauthRedirectUri } from "./OAuthButtons";
import { rememberOAuthIntent, type PendingAction } from "./oauth-intent";
import { external } from "./redirect";
import { isOAuthProvider, type OAuthProvider } from "./sign-in-options";

type Method = "password" | "totp" | "oauth";

/** 旧服务端没有 `me.signInMethods`：按以前的口令加验证码处理。 */
const LEGACY_METHODS: readonly Method[] = ["password", "totp"];

const METHOD_SWITCH: Record<Method, string> = {
  password: "cloud.auth.stepUpPassword",
  totp: "cloud.auth.stepUpCode",
  oauth: "cloud.auth.stepUpProvider",
};

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

/**
 * 再验证一次（`auth.stepUp`，10 分钟窗口）：口令、两步验证码，或用已绑定的提供方再授权一次
 * （`auth.stepUpOAuthStart`，整页跳走，回来由 `OAuthCallbackPage` 接着做 `action`）。
 * 可用的方式按 `me.signInMethods.stepUp`。`onVerified` 重试原操作，答错误文案（没有是空串）。
 */
export function StepUpDialog({
  action = null,
  onVerified,
  onCancel,
}: {
  /** 提权后要接着做的事：跳去提供方之前存下，回来自动续。 */
  action?: PendingAction | null;
  onVerified: () => Promise<string | void> | string | void;
  onCancel: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const field = React.useRef<HTMLInputElement>(null);
  const methodsQuery = useQuery(signInMethodsQuery(api));
  const providers = React.useMemo(
    () =>
      (methodsQuery.data?.providers ?? [])
        .map((entry) => entry.provider)
        .filter(isOAuthProvider),
    [methodsQuery.data],
  );
  const available: readonly Method[] = React.useMemo(() => {
    if (methodsQuery.data === undefined)
      return methodsQuery.isError ? LEGACY_METHODS : [];
    return methodsQuery.data.stepUp;
  }, [methodsQuery.data, methodsQuery.isError]);
  const [chosen, setChosen] = React.useState<Method | null>(null);
  const method: Method | null =
    chosen !== null && available.includes(chosen)
      ? chosen
      : (available[0] ?? null);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (error !== "") field.current?.focus();
  }, [error]);

  const finish = async () => {
    setValue("");
    const message = await onVerified();
    if (typeof message === "string" && message !== "") setError(message);
  };

  const submit = async () => {
    if (working || value.trim() === "" || method === null || method === "oauth")
      return;
    setWorking(true);
    setError("");
    try {
      await api.client.auth.stepUp(
        method === "totp" ? { totpCode: value.trim() } : { password: value },
      );
      await finish();
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setWorking(false);
    }
  };

  const viaProvider = async (provider: OAuthProvider) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const answer = await api.client.auth.stepUpOAuthStart({
        provider,
        redirectUri: oauthRedirectUri(provider),
      });
      rememberOAuthIntent(
        { purpose: "reauth", provider },
        currentPath(),
        action,
      );
      // 整页跳走：按钮保持转圈，直到页面被换掉。
      external.go(answer.authorizationUrl);
    } catch (failure) {
      const { code } = toCloudError(failure);
      setError(
        code === "not_found"
          ? t("cloud.auth.oauthUnavailable")
          : describeFailure(failure),
      );
      setWorking(false);
    }
  };

  const others = available.filter((entry) => entry !== method);
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.auth.stepUpTitle")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {method === "oauth" ? (
          <div className="flex flex-col gap-3">
            {providers.map((provider) => (
              <Button
                key={provider}
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                loading={working}
                onClick={() => void viaProvider(provider)}
              >
                {t(`cloud.auth.stepUpVia.${provider}`)}
              </Button>
            ))}
            {error !== "" && (
              <p role="alert" className="text-body text-destructive">
                {error}
              </p>
            )}
          </div>
        ) : method === null ? null : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field data-invalid={error !== "" || undefined}>
              <FieldLabel htmlFor={`${id}-secret`}>
                {method === "totp" ? t("auth.mfa.code") : t("auth.password")}
              </FieldLabel>
              <Input
                key={method}
                ref={field}
                id={`${id}-secret`}
                type={method === "totp" ? "text" : "password"}
                name={method === "totp" ? "totp" : "password"}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- 设计要求：表单或对话框打开时焦点落到首个输入
                autoFocus
                autoComplete={
                  method === "totp" ? "one-time-code" : "current-password"
                }
                inputMode={method === "totp" ? "numeric" : undefined}
                value={value}
                disabled={working}
                aria-invalid={error !== "" || undefined}
                aria-describedby={error === "" ? undefined : `${id}-error`}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError("");
                }}
              />
              <FieldError id={`${id}-error`}>{error}</FieldError>
            </Field>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={value.trim() === ""}
              loading={working}
            >
              {t("cloud.auth.stepUpConfirm")}
            </Button>
          </form>
        )}
        {others.map((entry) => (
          <Button
            key={entry}
            type="button"
            variant="ghost"
            onClick={() => {
              setChosen(entry);
              setValue("");
              setError("");
            }}
          >
            {t(METHOD_SWITCH[entry])}
          </Button>
        ))}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cloud.auth.stepUpCancel")}
        </Button>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 用户关掉了提权对话框：调用方静默放弃，不当作失败。 */
export class StepUpCancelled extends Error {
  constructor() {
    super("step-up cancelled");
  }
}

export const isStepUpCancelled = (error: unknown) =>
  error instanceof StepUpCancelled;

/**
 * 任何 `mfa_required` 都打开 {@link StepUpDialog}：`run(op)` 先试一次，要提权就弹对话框，
 * 验证成功后重试 `op`；取消答 {@link StepUpCancelled}。把 `dialog` 渲染在调用方里。
 */
export function useStepUp() {
  const [request, setRequest] = React.useState<{
    action: PendingAction | null;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null>(null);

  const run = React.useCallback(
    async <T,>(
      op: () => Promise<T>,
      action: PendingAction | null = null,
    ): Promise<T> => {
      try {
        return await op();
      } catch (failure) {
        if (toCloudError(failure).code !== "mfa_required") throw failure;
      }
      await new Promise<void>((resolve, reject) =>
        setRequest({ action, resolve, reject }),
      );
      return op();
    },
    [],
  );

  const dialog =
    request === null ? null : (
      <StepUpDialog
        action={request.action}
        onVerified={() => {
          request.resolve();
          setRequest(null);
        }}
        onCancel={() => {
          request.reject(new StepUpCancelled());
          setRequest(null);
        }}
      />
    );
  return { run, dialog };
}
