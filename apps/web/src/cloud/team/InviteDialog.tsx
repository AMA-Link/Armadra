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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Textarea } from "@/ui/textarea";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { tp } from "../i18n-plural";
import { useInvite, useTeamSettings, type TeamSpace } from "./data";
import { INVITE_ROLES, type InviteRole } from "./roles";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEPARATORS = /[\s,;\uFF0C\uFF1B]+/;

/** 输入框里的邮箱：逗号、分号、空白或换行分隔，按小写去重。 */
export function parseEmails(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(SEPARATORS)
    .filter((entry) => entry !== "")
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * 邀请成员（云端控制台 §3.3.2）：多个邮箱加一个角色。逐个校验，错误标出第几个；逐个发送，
 * 中途失败就停下，已发出的从输入框里去掉，剩下的留着重试。
 */
export function InviteDialog({
  space,
  onClose,
}: {
  space: TeamSpace;
  onClose: () => void;
}) {
  const t = useT();
  const invite = useInvite(space);
  // 团队关了访客：不提供「访客」这个角色（云端也会答 guests_disabled）。
  const guestsAllowed = useTeamSettings(space).data?.allowGuests !== false;
  const [text, setText] = React.useState("");
  const [role, setRole] = React.useState<InviteRole>("member");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const id = React.useId();

  const submit = async () => {
    const emails = parseEmails(text);
    const bad = emails.findIndex((email) => !EMAIL.test(email));
    if (emails.length === 0 || bad >= 0) {
      setError(
        emails.length === 0
          ? t("cloud.team.inviteEmailsRequired")
          : t("cloud.team.inviteEmailInvalid", { index: bad + 1 }),
      );
      area.current?.focus();
      return;
    }
    setBusy(true);
    const left = [...emails];
    let sent = 0;
    try {
      for (const email of emails) {
        try {
          await invite.mutateAsync({ email, role });
          left.shift();
          sent += 1;
        } catch (failure) {
          setText(left.join("\n"));
          setError(
            t("cloud.team.inviteFailed", {
              email,
              reason: describeFailure(failure),
            }),
          );
          area.current?.focus();
          return;
        }
      }
      onClose();
    } finally {
      setBusy(false);
      if (sent > 0) toast.success(tp("cloud.team.invited", sent));
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.team.invite")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field data-invalid={error !== "" || undefined}>
            <FieldLabel htmlFor={id}>{t("cloud.team.inviteEmails")}</FieldLabel>
            <Textarea
              id={id}
              ref={area}
              value={text}
              rows={3}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={error !== "" || undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setText(event.target.value);
                setError("");
              }}
            />
            {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-role`}>
              {t("cloud.team.role")}
            </FieldLabel>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as InviteRole)}
            >
              <SelectTrigger id={`${id}-role`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {INVITE_ROLES.filter(
                  (entry) => entry !== "guest" || guestsAllowed,
                ).map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(`cloud.team.role.${entry}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button type="submit" loading={busy}>
              {t("cloud.team.inviteAction")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
