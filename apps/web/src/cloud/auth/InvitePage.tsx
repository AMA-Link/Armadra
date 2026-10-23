import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { useCloudApi } from "../api/context";
import { describeFailure, isSessionError, toCloudError } from "../api/errors";
import { navigate } from "../router";
import { AuthLayout } from "./AuthLayout";
import { fragmentToken } from "./redirect";

type Preview = Awaited<
  ReturnType<ReturnType<typeof useCloudApi>["client"]["invitations"]["get"]>
>;
type Stage =
  | { kind: "loading" }
  | { kind: "ready"; preview: Preview }
  | { kind: "failed"; message: string }
  | { kind: "done"; accepted: boolean };

/**
 * `/invite/:id#<令牌>`（邮件链接，云端 §4.3）：匿名取摘要（`invitations.get`），接受 / 拒绝要登录，
 * 没登录就带着 `next` 与片段去 `/login`，登录后回到这里。令牌只在内存和 `#` 里，不进查询。
 */
export function InvitePage({
  invitationId,
  onDone,
}: {
  invitationId: string;
  /** 接受后去空间概览。 */
  onDone: () => void;
}) {
  const t = useT();
  const api = useCloudApi();
  const [token] = React.useState(() => fragmentToken());
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<Stage>(
    token === ""
      ? { kind: "failed", message: t("error.invitationInvalid") }
      : { kind: "loading" },
  );

  React.useEffect(() => {
    if (token === "") return;
    let live = true;
    api.client.invitations.get({ invitationId, token }).then(
      (preview) => live && setStage({ kind: "ready", preview }),
      (failure: unknown) =>
        live && setStage({ kind: "failed", message: describeFailure(failure) }),
    );
    return () => {
      live = false;
    };
  }, [api, invitationId, token]);

  const answer = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (accept) await api.client.invitations.accept({ invitationId, token });
      else await api.client.invitations.decline({ invitationId, token });
      setStage({ kind: "done", accepted: accept });
    } catch (failure) {
      if (isSessionError(failure) || toCloudError(failure).status === 401) {
        const next = encodeURIComponent(`/invite/${invitationId}`);
        navigate(`/login?next=${next}#${encodeURIComponent(token)}`);
        return;
      }
      setStage({ kind: "failed", message: describeFailure(failure) });
    } finally {
      setBusy(false);
    }
  };

  if (stage.kind === "loading")
    return (
      <AuthLayout title={t("cloud.auth.inviteTitle")}>
        <Skeleton className="h-8 w-full" aria-busy="true" />
      </AuthLayout>
    );

  if (stage.kind === "failed")
    return (
      <AuthLayout title={t("cloud.auth.inviteTitle")} subtitle={stage.message}>
        <Button size="lg" className="w-full" onClick={onDone}>
          {t("cloud.auth.continue")}
        </Button>
      </AuthLayout>
    );

  if (stage.kind === "done")
    return (
      <AuthLayout
        title={
          stage.accepted
            ? t("cloud.auth.inviteAccepted")
            : t("cloud.auth.inviteDeclined")
        }
      >
        <Button size="lg" className="w-full" autoFocus onClick={onDone}>
          {t("cloud.auth.continue")}
        </Button>
      </AuthLayout>
    );

  const { preview } = stage;
  const subject =
    preview.kind === "team"
      ? t("cloud.auth.inviteTeam", {
          inviter: preview.inviterName,
          team: preview.teamName ?? "",
        })
      : t("cloud.auth.inviteHost", {
          inviter: preview.inviterName,
          host: preview.sourceName ?? "",
        });
  const closed =
    preview.state === "expired"
      ? t("error.invitationExpired")
      : preview.state === "revoked"
        ? t("error.invitationRevoked")
        : preview.state === "pending"
          ? null
          : t("cloud.auth.inviteClosed");

  return (
    <AuthLayout
      title={t("cloud.auth.inviteTitle")}
      subtitle={closed ?? subject}
    >
      {closed === null ? (
        <>
          <p className="text-center text-caption text-muted-foreground">
            {t("cloud.auth.inviteEmail", { email: preview.emailHint })}
          </p>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              className="w-full"
              loading={busy}
              onClick={() => void answer(true)}
            >
              {t("cloud.auth.inviteAccept")}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              disabled={busy}
              onClick={() => void answer(false)}
            >
              {t("cloud.auth.inviteDecline")}
            </Button>
          </div>
        </>
      ) : (
        <Button size="lg" className="w-full" onClick={onDone}>
          {t("cloud.auth.continue")}
        </Button>
      )}
    </AuthLayout>
  );
}
