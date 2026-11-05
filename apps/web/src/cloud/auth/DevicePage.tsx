import * as React from "react";
import {
  CircleCheck,
  CircleX,
  Globe,
  Monitor,
  Server,
  Smartphone,
} from "lucide-react";

import { useT, t as translate } from "@/app/preferences-store";
import { formatElapsedTime } from "@/lib/format";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/ui/input-otp";
import { Skeleton } from "@/ui/skeleton";
import { EmptyState } from "@/ui/state";
import type { CloudClient } from "../api/client";
import { useCloudApi } from "../api/context";
import { describeFailure, isSessionError, toCloudError } from "../api/errors";
import { AuthLayout } from "./AuthLayout";
import { StepUpDialog } from "./StepUpDialog";
import { APP_RETURN_URL, isMobilePlatform, returnToApp } from "./app-return";
import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  cleanUserCode,
  normalizeUserCode,
} from "./device-code";

/**
 * `auth.deviceGet` 的答复里页面用到的部分。`ipPrefix` 是发起请求的 IP（IPv6 截到 /64），
 * 可缺省（旧服务端不报，cloud#88）。
 */
export type DeviceRequest = Pick<
  Awaited<ReturnType<CloudClient["auth"]["deviceGet"]>>,
  "platform" | "name" | "requestedAtMs" | "ipPrefix"
>;

type Stage =
  | { kind: "enter" }
  | { kind: "loading" }
  | { kind: "ready"; userCode: string; request: DeviceRequest }
  | { kind: "stepUp"; userCode: string; request: DeviceRequest }
  | { kind: "done"; approved: boolean; name: string; mobile: boolean };

const PLATFORM_ICON = {
  ios: Smartphone,
  android: Smartphone,
  desktop: Monitor,
  browser: Globe,
  server: Server,
} as const;

type Platform = keyof typeof PLATFORM_ICON;
const isPlatform = (value: string): value is Platform => value in PLATFORM_ICON;

/** 请求发出的时间：与其它相对时间同一写法（`lib/format`，「刚刚」「3 分钟前」）。 */
export function requestedAgo(requestedAtMs: number, now: number): string {
  return formatElapsedTime(requestedAtMs, now);
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

  // 手机 App 发起的设备码被批准：自动回到 App（被系统拦掉时用页面上的按钮）。
  const returning = stage.kind === "done" && stage.mobile;
  React.useEffect(() => {
    if (returning) returnToApp();
  }, [returning]);

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
    // 防御纵深：链接来的码没核对前不批准（按钮本来就禁用）。
    if (approve && fromUrl && !verified) return "";
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
      setStage({
        kind: "done",
        approved: approve,
        name: request.name,
        // 只有批准才把手机 App 带回去；拒绝不跳。
        mobile: approve && isMobilePlatform(request.platform),
      });
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
        {stage.mobile && (
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 设计要求：表单或对话框打开时焦点落到首个输入
          <Button size="lg" className="w-full" autoFocus asChild>
            <a href={APP_RETURN_URL}>{t("cloud.auth.deviceReturn")}</a>
          </Button>
        )}
        <Button
          size="lg"
          variant={stage.mobile ? "ghost" : "default"}
          className="w-full"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 设计要求：表单或对话框打开时焦点落到首个输入
          autoFocus={!stage.mobile}
          onClick={onDone}
        >
          {t("cloud.auth.continue")}
        </Button>
      </AuthLayout>
    );

  if (stage.kind === "ready" || stage.kind === "stepUp") {
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
                  time: requestedAgo(request.requestedAtMs, Date.now()),
                })}
              </p>
              {request.ipPrefix !== undefined && request.ipPrefix !== "" && (
                <p className="text-meta text-muted-foreground tabular-nums break-all">
                  {t("cloud.auth.deviceFrom", { ip: request.ipPrefix })}
                </p>
              )}
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
        {stage.kind === "stepUp" && (
          <StepUpDialog
            onCancel={() => {
              setStage({ kind: "ready", userCode, request });
              setError("");
            }}
            onVerified={() => decide(userCode, request, true)}
          />
        )}
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
            // eslint-disable-next-line jsx-a11y/no-autofocus -- 设计要求：表单或对话框打开时焦点落到首个输入
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
