import * as React from "react";
import {
  CircleCheck,
  CircleX,
  Globe,
  Monitor,
  Server,
  Smartphone,
} from "lucide-react";

import {
  usePreferencesStore,
  useT,
  t as translate,
} from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/ui/input-otp";
import { Skeleton } from "@/ui/skeleton";
import { EmptyState } from "@/ui/state";
import { useCloudApi } from "../api/context";
import { describeFailure, isSessionError, toCloudError } from "../api/errors";
import { AuthLayout } from "./AuthLayout";
import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  cleanUserCode,
  normalizeUserCode,
} from "./device-code";

/** `auth.deviceGet` 的答复里页面用到的部分。 */
export interface DeviceRequest {
  readonly platform: string;
  readonly name: string;
  readonly requestedAtMs: number;
}

type Stage =
  | { kind: "enter" }
  | { kind: "loading" }
  | { kind: "ready"; userCode: string; request: DeviceRequest }
  | { kind: "stepUp"; userCode: string; request: DeviceRequest }
  | { kind: "done"; approved: boolean; name: string };

const PLATFORM_ICON = {
  ios: Smartphone,
  android: Smartphone,
  desktop: Monitor,
  browser: Globe,
  server: Server,
} as const;

type Platform = keyof typeof PLATFORM_ICON;
const isPlatform = (value: string): value is Platform => value in PLATFORM_ICON;

/** 请求发出的时间：一分钟内是「刚刚」，其余按本地化的相对时间。 */
export function requestedAgo(
  requestedAtMs: number,
  now: number,
  locale: string,
  justNow: string,
): string {
  const minutes = Math.floor((now - requestedAtMs) / 60_000);
  if (minutes < 1) return justNow;
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    -minutes,
    "minute",
  );
}

/** 失败 → 设备码输入框下那句话（查无此码按页面自己的文案，其余按错误码）。 */
function codeMessage(failure: unknown): string {
  return toCloudError(failure).code === "not_found"
    ? translate("cloud.auth.deviceCodeWrong")
    : describeFailure(failure);
}

/** 没有会话（或会话失效）：去登录。`mfa_required` 也是 401，但它是「要提权」，不算。 */
function needsLogin(failure: unknown): boolean {
  const { code, status } = toCloudError(failure);
  return code !== "mfa_required" && (isSessionError(failure) || status === 401);
}

/**
 * `/device?code=`（云端控制台 §3.1.5）：桌面 core、CLI 用设备码登录时，在已登录的浏览器里核对
 * 请求方再批准。URL 只可能带 user_code（`XXXX-XXXX`），device_code 从不出现在页面里。
 * 没有会话先 `onNeedLogin(userCode)`（上层 `replace` 去 `/login`，登录后带着码回来）；
 * 批准时云端要求提权（`mfa_required`）就在页面里走 `auth.stepUp`。
 */
export function DevicePage({
  code,
  onNeedLogin,
  onDone,
}: {
  /** 地址里的 `?code=`，没有是 `null`。 */
  code: string | null;
  /** 没有会话：上层保留码、`replace` 跳 `/login?next=`。 */
  onNeedLogin: (userCode: string) => void;
  onDone: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const locale = usePreferencesStore((state) => state.locale);
  const id = React.useId();
  const codeInput = React.useRef<HTMLInputElement>(null);
  // 上层每次渲染都给新的回调：放进 ref，免得它进依赖后每次渲染都重新查一遍码。
  const login = React.useRef(onNeedLogin);
  login.current = onNeedLogin;
  const needLogin = React.useCallback(
    (userCode: string) => login.current(userCode),
    [],
  );
  const [typed, setTyped] = React.useState(() => cleanUserCode(code ?? ""));
  const [stage, setStage] = React.useState<Stage>(() =>
    normalizeUserCode(code) === null ? { kind: "enter" } : { kind: "loading" },
  );
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // 码来自链接（可能是别人发来的）：授权前要人确认核对过设备上显示的码。手输的码本身就是核对。
  const [fromUrl] = React.useState(() => normalizeUserCode(code) !== null);
  const [verified, setVerified] = React.useState(false);

  const lookup = React.useCallback(
    async (userCode: string, live: () => boolean = () => true) => {
      setStage({ kind: "loading" });
      setError("");
      try {
        // 先保证有会话（没有就 `auth.refresh` 取回 CSRF 值）：没有会话不去猜码。
        if (!(await api.ensureCsrf())) {
          if (live()) needLogin(userCode);
          return;
        }
        const request = await api.client.auth.deviceGet({ userCode });
        if (live()) setStage({ kind: "ready", userCode, request });
      } catch (failure) {
        if (!live()) return;
        if (needsLogin(failure)) {
          needLogin(userCode);
          return;
        }
        setStage({ kind: "enter" });
        setError(codeMessage(failure));
      }
    },
    [api, needLogin],
  );

  // 地址里带着合法的码：直接进第二步。
  React.useEffect(() => {
    const userCode = normalizeUserCode(code);
    if (userCode === null) return;
    let live = true;
    void lookup(userCode, () => live);
    return () => {
      live = false;
    };
  }, [code, lookup]);

  // 第一个错误落在输入框上：焦点回到设备码。
  React.useEffect(() => {
    if (error !== "" && stage.kind === "enter") codeInput.current?.focus();
  }, [error, stage.kind]);

  /** 批准 / 拒绝。答错误文案（页面留在原处显示）；`""` = 成功或已交给上层处理。 */
  const decide = async (
    userCode: string,
    request: DeviceRequest,
    approve: boolean,
  ): Promise<string> => {
    if (busy) return "";
    setBusy(true);
    setError("");
    try {
      if (!(await api.ensureCsrf())) {
        needLogin(userCode);
        return "";
      }
      if (approve)
        await api.client.auth.deviceApprove({ userCode, approve: true });
      else await api.client.auth.deviceDeny({ userCode });
      setStage({ kind: "done", approved: approve, name: request.name });
      return "";
    } catch (failure) {
      const { code: failed } = toCloudError(failure);
      if (failed === "mfa_required") {
        setStage({ kind: "stepUp", userCode, request });
        return "";
      }
      if (needsLogin(failure)) {
        needLogin(userCode);
        return "";
      }
      if (failed === "not_found" || failed === "device_code_expired") {
        setStage({ kind: "enter" });
        setError(codeMessage(failure));
        return "";
      }
      const message = describeFailure(failure);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  if (stage.kind === "loading")
    return (
      <AuthLayout title={t("cloud.auth.deviceTitle")}>
        <div
          role="status"
          aria-busy="true"
          aria-label={t("state.loading")}
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-(--row-h) w-full" />
          <Skeleton className="h-(--row-h) w-full" />
        </div>
      </AuthLayout>
    );

  if (stage.kind === "done")
    return (
      <AuthLayout title={t("cloud.auth.deviceTitle")}>
        <EmptyState
          icon={
            stage.approved ? (
              <CircleCheck aria-hidden />
            ) : (
              <CircleX aria-hidden />
            )
          }
          title={
            stage.approved
              ? t("cloud.auth.deviceApproved", { name: stage.name })
              : t("error.deviceCodeDenied")
          }
          headingLevel={2}
        />
        <Button size="lg" className="w-full" autoFocus onClick={onDone}>
          {t("cloud.auth.continue")}
        </Button>
      </AuthLayout>
    );

  if (stage.kind === "stepUp")
    return (
      <StepUp
        busy={busy}
        onCancel={() => {
          setStage({
            kind: "ready",
            userCode: stage.userCode,
            request: stage.request,
          });
          setError("");
        }}
        onVerified={() => decide(stage.userCode, stage.request, true)}
      />
    );

  if (stage.kind === "ready") {
    const { userCode, request } = stage;
    const Icon = isPlatform(request.platform)
      ? PLATFORM_ICON[request.platform]
      : Monitor;
    // 平台字符串由发起设备自报：认不出的一律是通用「设备」，不把原文当文案。
    const platform = isPlatform(request.platform)
      ? t(`cloud.auth.platform.${request.platform}`)
      : t("cloud.auth.platform.unknown");
    return (
      <AuthLayout title={t("cloud.auth.deviceTitle")}>
        <Card>
          <CardContent className="flex items-center gap-3">
            <Icon
              className="size-5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="flex min-w-0 flex-col">
              <p className="text-body font-medium break-words">
                {t("cloud.auth.deviceRequest", { name: request.name })}
              </p>
              <p className="text-meta text-muted-foreground tabular-nums">
                {t("cloud.auth.deviceRequested", {
                  platform,
                  time: requestedAgo(
                    request.requestedAtMs,
                    Date.now(),
                    locale,
                    t("cloud.auth.deviceNow"),
                  ),
                })}
              </p>
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-col items-center gap-1">
          <p className="text-meta text-muted-foreground">
            {t("cloud.auth.deviceCode")}
          </p>
          <p
            data-slot="device-user-code"
            className="font-mono text-display font-semibold tracking-widest tabular-nums"
          >
            {userCode}
          </p>
        </div>
        <p className="text-center text-meta text-muted-foreground text-balance">
          {t("cloud.auth.deviceWarning")}
        </p>
        {fromUrl && (
          <Field orientation="horizontal">
            <Checkbox
              id={`${id}-verified`}
              checked={verified}
              disabled={busy}
              onCheckedChange={(value) => setVerified(value === true)}
            />
            <FieldLabel htmlFor={`${id}-verified`}>
              {t("cloud.auth.deviceVerified")}
            </FieldLabel>
          </Field>
        )}
        {error !== "" && (
          <p role="alert" className="text-center text-body text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="lg"
            className="flex-1"
            disabled={busy}
            onClick={() => void decide(userCode, request, false)}
          >
            {t("cloud.auth.deviceDeny")}
          </Button>
          <Button
            size="lg"
            className="flex-1"
            disabled={fromUrl && !verified}
            loading={busy}
            onClick={() => void decide(userCode, request, true)}
          >
            {t("cloud.auth.deviceApprove")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const complete = typed.length === USER_CODE_LENGTH;
  return (
    <AuthLayout title={t("cloud.auth.deviceTitle")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const userCode = normalizeUserCode(typed);
          if (userCode === null) setError(t("cloud.auth.deviceCodeWrong"));
          else void lookup(userCode);
        }}
      >
        <Field data-invalid={error !== "" || undefined}>
          <FieldLabel htmlFor={`${id}-code`}>
            {t("cloud.auth.deviceCode")}
          </FieldLabel>
          <InputOTP
            ref={codeInput}
            id={`${id}-code`}
            maxLength={USER_CODE_LENGTH}
            value={typed}
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            pushPasswordManagerStrategy="none"
            pattern={`^[${USER_CODE_ALPHABET}${USER_CODE_ALPHABET.toLowerCase()}]*$`}
            pasteTransformer={cleanUserCode}
            aria-invalid={error !== "" || undefined}
            aria-describedby={error === "" ? undefined : `${id}-error`}
            containerClassName="justify-center"
            onChange={(value) => {
              setTyped(cleanUserCode(value));
              setError("");
            }}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3].map((index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={error !== "" || undefined}
                />
              ))}
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              {[4, 5, 6, 7].map((index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={error !== "" || undefined}
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <FieldError id={`${id}-error`} className="text-center">
            {error}
          </FieldError>
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={!complete}>
          {t("cloud.auth.continue")}
        </Button>
      </form>
    </AuthLayout>
  );
}

/**
 * 批准要求提权（`mfa_required`）：口令或验证码二选一，`auth.stepUp` 成功（10 分钟窗口）后
 * 回到上层重试批准。
 */
function StepUp({
  busy,
  onCancel,
  onVerified,
}: {
  busy: boolean;
  onCancel: () => void;
  /** 重试批准；答错误文案（没有错误是 `""`）。 */
  onVerified: () => Promise<string>;
}) {
  const t = useT();
  const api = useCloudApi();
  const id = React.useId();
  const field = React.useRef<HTMLInputElement>(null);
  const [useCode, setUseCode] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (error !== "") field.current?.focus();
  }, [error]);

  const submit = async () => {
    if (working || busy || value.trim() === "") return;
    setWorking(true);
    setError("");
    try {
      await api.client.auth.stepUp(
        useCode ? { totpCode: value.trim() } : { password: value },
      );
      setValue("");
      setError(await onVerified());
    } catch (failure) {
      setError(describeFailure(failure));
    } finally {
      setWorking(false);
    }
  };

  return (
    <AuthLayout title={t("cloud.auth.stepUpTitle")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field data-invalid={error !== "" || undefined}>
          <FieldLabel htmlFor={`${id}-secret`}>
            {useCode ? t("auth.mfa.code") : t("auth.password")}
          </FieldLabel>
          <Input
            key={useCode ? "code" : "password"}
            ref={field}
            id={`${id}-secret`}
            type={useCode ? "text" : "password"}
            name={useCode ? "totp" : "password"}
            autoFocus
            autoComplete={useCode ? "one-time-code" : "current-password"}
            inputMode={useCode ? "numeric" : undefined}
            value={value}
            disabled={working || busy}
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
          loading={working || busy}
        >
          {t("cloud.auth.stepUpConfirm")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setUseCode(!useCode);
            setValue("");
            setError("");
          }}
        >
          {useCode
            ? t("cloud.auth.stepUpPassword")
            : t("cloud.auth.stepUpCode")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cloud.auth.stepUpCancel")}
        </Button>
      </form>
    </AuthLayout>
  );
}
