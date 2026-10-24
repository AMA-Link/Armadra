import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";

export interface TypedConfirmProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 标题（复述对象名，如「删除「研发组」？」），由调用方经 i18n 给出。 */
  readonly title: string;
  /** 必须原样输入的值：团队地址、邮箱、主机名。 */
  readonly expected: string;
  /** 确认按钮：复述后果（「删除团队」），不用「确定」。 */
  readonly actionLabel: string;
  /** 运营的写动作要先填理由（写进审计）：给了就在输入确认之前多一栏必填的理由，`onConfirm` 收到它。 */
  readonly reason?: boolean;
  readonly onConfirm: (reason: string) => void | Promise<void>;
}

const REASON_MAX = 500;

/**
 * 输入确认的危险对话框（云端控制台 §4.3）。确认按钮不预先禁用：输入不一致时点击，
 * 输入框 `aria-invalid`、下方一行「与 {value} 不一致」并聚焦。成功后关闭；
 * `onConfirm` 抛错时留着，由调用方提示。
 */
export function TypedConfirm({
  open,
  onOpenChange,
  ...body
}: TypedConfirmProps) {
  const input = React.useRef<HTMLInputElement>(null);
  const reason = React.useRef<HTMLTextAreaElement>(null);
  return (
    <ResponsiveAlertDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveAlertDialogContent
        aria-describedby={undefined}
        // 要先输入才能确认：焦点落在第一个输入框，不是「取消」。
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (body.reason ? reason : input).current?.focus();
        }}
      >
        <Body
          input={input}
          reasonInput={reason}
          onOpenChange={onOpenChange}
          {...body}
        />
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  );
}

function Body({
  input,
  reasonInput,
  reason: withReason = false,
  title,
  expected,
  actionLabel,
  onConfirm,
  onOpenChange,
}: Omit<TypedConfirmProps, "open"> & {
  input: React.RefObject<HTMLInputElement | null>;
  reasonInput: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const [value, setValue] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const [why, setWhy] = React.useState("");
  const [whyInvalid, setWhyInvalid] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();

  const submit = async () => {
    if (withReason && why.trim() === "") {
      setWhyInvalid(true);
      reasonInput.current?.focus();
      return;
    }
    if (value !== expected) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await onConfirm(why.trim());
      onOpenChange(false);
    } catch {
      /* 失败的提示归调用方（sonner）；对话框留着，可以重试。 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ResponsiveAlertDialogHeader>
        <ResponsiveAlertDialogTitle>{title}</ResponsiveAlertDialogTitle>
      </ResponsiveAlertDialogHeader>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {withReason ? (
          <Field data-invalid={whyInvalid || undefined}>
            <FieldLabel htmlFor={`${id}-reason`}>
              {t("cloud.ops.reason")}
            </FieldLabel>
            <Textarea
              ref={reasonInput}
              id={`${id}-reason`}
              value={why}
              maxLength={REASON_MAX}
              aria-invalid={whyInvalid || undefined}
              aria-describedby={whyInvalid ? `${id}-reason-error` : undefined}
              onChange={(event) => {
                setWhy(event.target.value);
                setWhyInvalid(false);
              }}
            />
            {whyInvalid ? (
              <FieldError id={`${id}-reason-error`}>
                {t("cloud.ops.reasonRequired")}
              </FieldError>
            ) : null}
          </Field>
        ) : null}
        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor={id}>
            {t("cloud.common.confirmType", { value: expected })}
          </FieldLabel>
          <Input
            ref={input}
            id={id}
            value={value}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-error` : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid ? (
            <FieldError id={`${id}-error`}>
              {t("cloud.common.confirmMismatch", { value: expected })}
            </FieldError>
          ) : null}
        </Field>
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>
            {t("cloud.common.cancel")}
          </ResponsiveAlertDialogCancel>
          <Button type="submit" variant="destructive-solid" loading={busy}>
            {actionLabel}
          </Button>
        </ResponsiveAlertDialogFooter>
      </form>
    </>
  );
}
