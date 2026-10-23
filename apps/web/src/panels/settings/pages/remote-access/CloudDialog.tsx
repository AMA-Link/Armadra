import * as React from "react";

import {
  type RemoteService,
  addCloud,
  cloudSpaces,
  pollCloudDevice,
  registerToSpace,
  retryAfterMs,
} from "../../../../api/remote-services";
import { useT } from "../../../../app/preferences-store";
import { RuntimeRequestError } from "../../../../api/request";
import { openExternal } from "../../../../platform";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";
import { checkAddress } from "../remote-address";

/*
 * 添加 Armadra 云（契约 §33.11）：地址 → 设备码（在浏览器里批准）→ 选空间登记这台电脑。
 * 设备码的秘密部分留在 core，这里只有给人看的 8 位码。
 */

type Space = Awaited<ReturnType<typeof cloudSpaces>>["spaces"][number];
type Step =
  | { readonly kind: "address" }
  | {
      readonly kind: "code";
      readonly remote: RemoteService;
      readonly userCode: string;
      readonly verificationUrl: string;
      readonly intervalMs: number;
      readonly outcome: "waiting" | "denied" | "expired" | "failed";
    }
  | { readonly kind: "spaces-failed"; readonly remote: RemoteService }
  | {
      readonly kind: "space";
      readonly remote: RemoteService;
      readonly spaces: readonly Space[];
    };

const PERSONAL = "personal";

/** 这些角色不能登记主机（cloud-api §21）：置灰并附脚注。 */
const BLOCKED_ROLES = new Set(["guest", "billing"]);

function blocked(space: Space): boolean {
  return space.kind === "team" && BLOCKED_ROLES.has(space.role);
}

function spaceValue(space: Space): string {
  return space.kind === "personal" ? PERSONAL : `team:${space.teamId}`;
}

export function AddCloudDialog({
  initialIssuer,
  onClose,
  onChanged,
}: {
  /** `null` 关着；空串是新加；有地址是重新登录。 */
  initialIssuer: string | null;
  onClose(): void;
  /** 源表变了（登录成功或登记成功）。 */
  onChanged(): void;
}) {
  const t = useT();
  const [issuer, setIssuer] = React.useState("");
  const [step, setStep] = React.useState<Step>({ kind: "address" });
  const [chosen, setChosen] = React.useState(PERSONAL);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const open = initialIssuer !== null;

  // 主机配额与别的上限分开说（details.quota === "hosts"）。
  function failureText(failure: unknown): string {
    if (
      failure instanceof RuntimeRequestError &&
      failure.code === "limit_reached"
    ) {
      const details = (failure.body as { details?: { quota?: unknown } } | null)
        ?.details;
      return t(
        details?.quota === "hosts"
          ? "remote.cloud.hostsLimit"
          : "remote.cloud.limitReached",
      );
    }
    return failure instanceof Error ? failure.message : String(failure);
  }

  React.useEffect(() => {
    if (initialIssuer === null) return;
    setIssuer(initialIssuer);
    setStep({ kind: "address" });
    setChosen(PERSONAL);
    setError("");
    setBusy(false);
  }, [initialIssuer]);

  async function start() {
    if (busy) return;
    const checked = checkAddress(issuer);
    if (!checked.ok) {
      setError(t(checked.error));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await addCloud(checked.address);
      if (answer.next === "ready") {
        await toSpaces(answer.remote);
        return;
      }
      const code = answer.next.deviceCode;
      setStep({
        kind: "code",
        remote: answer.remote,
        userCode: code.userCode,
        verificationUrl: code.verificationUrl,
        intervalMs: code.intervalMs,
        outcome: "waiting",
      });
      onChanged();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function toSpaces(remote: RemoteService) {
    // 这台电脑已经登记到它：重新登录就绪后不再登记。
    if (remote.registered) {
      onChanged();
      onClose();
      return;
    }
    try {
      const { spaces } = await cloudSpaces(remote.serviceId);
      const first = spaces.find((one) => !blocked(one));
      setChosen(first === undefined ? PERSONAL : spaceValue(first));
      setError("");
      setStep({ kind: "space", remote, spaces });
      onChanged();
    } catch (failure) {
      setError(failureText(failure));
      setStep({ kind: "spaces-failed", remote });
    }
  }

  // 等批准：按服务端要求的间隔轮询；限流听 retryAfterMs；终结就停。
  const waiting =
    step.kind === "code" && step.outcome === "waiting" ? step : null;
  React.useEffect(() => {
    if (waiting === null || !open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next = waiting.intervalMs;
      try {
        const { status } = await pollCloudDevice(waiting.remote.serviceId);
        if (cancelled) return;
        if (status === "ready") {
          await toSpaces(waiting.remote);
          return;
        }
        if (status !== "pending") {
          setStep({ ...waiting, outcome: status });
          return;
        }
      } catch (failure) {
        if (cancelled) return;
        const wait = retryAfterMs(failure);
        if (wait === null) {
          setError(failureText(failure));
          setStep({ ...waiting, outcome: "failed" });
          return;
        }
        next = wait;
      }
      timer = setTimeout(() => void tick(), next);
    };
    timer = setTimeout(() => void tick(), waiting.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting?.remote.serviceId, waiting?.userCode, open]);

  async function register() {
    if (step.kind !== "space" || busy) return;
    setBusy(true);
    setError("");
    try {
      const picked = step.spaces.find((one) => spaceValue(one) === chosen);
      await registerToSpace({
        serviceId: step.remote.serviceId,
        space:
          picked?.kind === "team"
            ? { kind: "team", teamId: picked.teamId }
            : { kind: "personal" },
      });
      onChanged();
      onClose();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }

  const spaceLabel = (space: Space) =>
    space.kind === "personal" ? t("remote.cloud.space.personal") : space.name;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("remote.cloud.signIn")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (step.kind === "address") void start();
            else if (step.kind === "space") void register();
          }}
        >
          {step.kind === "address" && (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5" data-invalid={error !== ""}>
                <FieldLabel htmlFor="cloud-issuer">
                  {t("remote.field.issuer")}
                </FieldLabel>
                <Input
                  id="cloud-issuer"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  placeholder="https://cloud.example.com"
                  aria-invalid={error !== ""}
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {step.kind === "code" && (
            <div className="flex min-w-0 flex-col gap-3">
              <span className="text-meta text-muted-foreground">
                {t("remote.cloud.code")}
              </span>
              <p
                data-slot="user-code"
                className="font-mono text-title select-text"
              >
                {step.userCode}
              </p>
              <p className="text-body text-muted-foreground">
                {step.outcome === "waiting" && (
                  <>
                    <Spinner data-icon="inline-start" aria-hidden />
                    {t("remote.cloud.waiting")}
                  </>
                )}
                {step.outcome === "denied" && t("remote.cloud.denied")}
                {step.outcome === "expired" && t("remote.cloud.codeExpired")}
              </p>
            </div>
          )}
          {step.kind === "space" &&
            (step.spaces.length === 0 ? (
              <p className="text-body text-muted-foreground">
                {t("remote.cloud.noSpaces")}
              </p>
            ) : (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="cloud-space">
                  {t("remote.cloud.registerTo")}
                </FieldLabel>
                <Select value={chosen} onValueChange={setChosen}>
                  <SelectTrigger id="cloud-space">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {step.spaces.map((space) => (
                      <SelectItem
                        key={spaceValue(space)}
                        value={spaceValue(space)}
                        disabled={blocked(space)}
                      >
                        {spaceLabel(space)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {step.spaces.some(blocked) && (
                  <p className="text-meta text-muted-foreground">
                    {t("remote.cloud.space.blocked")}
                  </p>
                )}
              </Field>
            ))}
          {step.kind === "space" && chosen.startsWith("team:") && (
            <Alert>
              <AlertDescription>{t("remote.cloud.teamShell")}</AlertDescription>
            </Alert>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {step.kind === "space" && step.spaces.length === 0
                ? t("remote.cloud.done")
                : t("remote.cancel")}
            </Button>
            {step.kind === "address" && (
              <Button type="submit" disabled={busy || issuer.trim() === ""}>
                {busy && <Spinner data-icon="inline-start" aria-hidden />}
                {t("remote.cloud.start")}
              </Button>
            )}
            {step.kind === "code" && step.outcome === "waiting" && (
              <Button
                type="button"
                onClick={() => void openExternal(step.verificationUrl)}
              >
                {t("remote.cloud.openBrowser")}
              </Button>
            )}
            {step.kind === "code" && step.outcome !== "waiting" && (
              <Button
                type="button"
                onClick={() => {
                  setError("");
                  setStep({ kind: "address" });
                }}
              >
                {t("remote.cloud.newCode")}
              </Button>
            )}
            {step.kind === "spaces-failed" && (
              <Button type="button" onClick={() => void toSpaces(step.remote)}>
                {t("remote.cloud.retry")}
              </Button>
            )}
            {step.kind === "space" && step.spaces.length > 0 && (
              <Button
                type="submit"
                disabled={
                  busy ||
                  !step.spaces.some(
                    (one) => spaceValue(one) === chosen && !blocked(one),
                  )
                }
              >
                {busy && <Spinner data-icon="inline-start" aria-hidden />}
                {t("remote.cloud.register")}
              </Button>
            )}
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
