import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Share } from "lucide-react";

import { sessionsQuery } from "@/agent/sessions";
import { SHARE_LINK_MAX_USES, createShareLink } from "@/api/remote-services";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import {
  canShareNatively,
  copyText,
  shareLinksKey,
  shareNatively,
} from "@/panels/settings/RemoteShare";
import { QrImage } from "@/panels/settings/pages/gateway/PairingCard";
import { AddRelayDialog } from "@/panels/settings/pages/remote-access/dialogs";
import { useInternetRoute } from "@/panels/settings/pages/remote-access/hooks";
import {
  REMOTE_SECTION,
  useSourceTableChanged,
} from "@/panels/settings/pages/remote-access/keys";
import { useCanvasStore } from "@/store/canvas-store";
import { CloudShare } from "./CloudShare";
import { Button } from "@/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { toast } from "@/ui/toast";
import { useShareStore } from "./share-store";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 弹层里给的权限；「可接管」只在设置里给（#301）。 */
export const SHARE_DIALOG_ROLES = ["viewer", "editor", "operator"] as const;
type DialogRole = (typeof SHARE_DIALOG_ROLES)[number];

/** 有效期：缺省 7 天。 */
export const SHARE_DIALOG_DAYS = [7, 1, 30] as const;

type Scope = "workspace" | "session";

/**
 * 画布 / 工作空间的分享弹层（#301 B5）：范围（此工作空间 / 仅此会话）、权限
 * （只读缺省 / 可编辑 / 可执行）、有效期（7 天缺省 / 1 天 / 30 天）。建好就给
 * 二维码与整条链接；链接的列表、改名、撤销都在设置 → 远程访问。互联网路线
 * 没开时先在这里开（没有中转账号就先登录）。
 */
export function ShareDialog() {
  const request = useShareStore((state) => state.request);
  const close = useShareStore((state) => state.close);
  return (
    <ResponsiveDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ResponsiveDialogContent
        data-testid="share-dialog"
        className="z-(--z-dialog) sm:max-w-[440px]"
      >
        {request !== null && (
          <ShareBody
            key={request.workspaceId}
            workspaceId={request.workspaceId}
            workspaceName={request.workspaceName}
            onClose={close}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ShareBody({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose(): void;
}) {
  const t = useT();
  const client = useQueryClient();
  const internet = useInternetRoute();
  const changed = useSourceTableChanged();
  const [scope, setScope] = React.useState<Scope>("workspace");
  const [sessionId, setSessionId] = React.useState("");
  const [role, setRole] = React.useState<DialogRole>("viewer");
  const [days, setDays] = React.useState<number>(7);
  const [created, setCreated] = React.useState<string | null>(null);
  const [signingIn, setSigningIn] = React.useState(false);

  const sessions = useQuery({
    ...sessionsQuery(workspaceId),
    enabled: scope === "session",
  });
  const sessionList = sessions.data ?? [];
  const session =
    sessionList.find((one) => one.sessionId === sessionId) ?? sessionList[0];
  const account = internet.registered[0];
  // 本机已登记到 Armadra 云：多出授予与邀请一组（云端控制台 §3.5.2）。
  const cloud = internet.remotes.find(
    (remote) =>
      remote.kind === "saas" && remote.registered && remote.hasCredentials,
  );

  // 为开路线先登录的：账号到了就开。
  const first = internet.shareable[0];
  const { mutate: startRoute } = internet.start;
  const [wantRoute, setWantRoute] = React.useState(false);
  React.useEffect(() => {
    if (!wantRoute || first === undefined) return;
    setWantRoute(false);
    if (!internet.on) startRoute(first);
  }, [wantRoute, first, internet.on, startRoute]);

  const create = useMutation({
    mutationFn: () => {
      const viewer = scope === "session" || role === "viewer";
      return createShareLink({
        serviceId: account?.serviceId ?? "",
        target: scope,
        workspaceId,
        ...(scope === "session" && session
          ? { sessionId: session.sessionId }
          : {}),
        readOnly: viewer,
        role: viewer ? "viewer" : role,
        ttlMs: days * DAY_MS,
        maxUses: SHARE_LINK_MAX_USES,
        label:
          scope === "session" ? session?.title || workspaceName : workspaceName,
      });
    },
    onSuccess: (result) => {
      if (account)
        void client.invalidateQueries({
          queryKey: shareLinksKey(account.serviceId),
        });
      setCreated(result.url);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function turnOnRoute() {
    if (first !== undefined) internet.start.mutate(first);
    else {
      setWantRoute(true);
      setSigningIn(true);
    }
  }

  function manage() {
    onClose();
    usePreferencesStore.getState().setLastSettingsSection(REMOTE_SECTION);
    useCanvasStore.getState().setPanel("settings", true);
  }

  const ready =
    account !== undefined &&
    (scope === "workspace" || session !== undefined) &&
    !create.isPending;

  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle className="truncate">
          {t("share.title", { name: workspaceName })}
        </ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      {created !== null ? (
        <div data-slot="share-created" className="flex min-w-0 flex-col gap-3">
          <div className="flex justify-center">
            <QrImage text={created} label={t("remote.invite.qr")} />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              readOnly
              aria-label={t("remote.invite.link")}
              value={created}
              className="min-w-0 font-mono text-meta"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void copyText(t, created)}
            >
              <Copy data-icon="inline-start" />
              {t("remote.invite.copy")}
            </Button>
            {canShareNatively() && (
              <IconButton
                size="cluster"
                label={t("remote.link.share")}
                onClick={() => void shareNatively(t, workspaceName, created)}
              >
                <Share />
              </IconButton>
            )}
          </div>
        </div>
      ) : (
        <form
          id="canvas-share-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) create.mutate();
          }}
        >
          <FieldGroup className="gap-4">
            {account === undefined && (
              <Field
                orientation="horizontal"
                className="justify-between"
                data-slot="share-route"
              >
                <FieldLabel>{t("share.route")}</FieldLabel>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={internet.busy}
                  onClick={turnOnRoute}
                >
                  {t(
                    first === undefined
                      ? "share.signIn"
                      : "remote.internet.start",
                  )}
                </Button>
              </Field>
            )}
            <Choice
              label={t("sharing.scope")}
              value={scope}
              onChange={(value) => setScope(value as Scope)}
              options={[
                ["workspace", t("share.scope.workspace")],
                ["session", t("share.scope.session")],
              ]}
            />
            {scope === "session" && (
              <Choice
                label={t("sharing.session")}
                value={session?.sessionId ?? ""}
                onChange={setSessionId}
                placeholder={t("sharing.session.none")}
                options={sessionList.map((one) => [
                  one.sessionId,
                  one.title || one.sessionId.slice(0, 8),
                ])}
              />
            )}
            {scope === "workspace" && (
              <Choice
                label={t("remote.invite.role")}
                value={role}
                onChange={(value) => setRole(value as DialogRole)}
                options={SHARE_DIALOG_ROLES.map((one) => [
                  one,
                  t(`workspaceGroups.role.${one}`),
                ])}
              />
            )}
            <Choice
              label={t("remote.invite.expires")}
              value={String(days)}
              onChange={(value) => setDays(Number(value))}
              options={SHARE_DIALOG_DAYS.map((one) => [
                String(one),
                t(`remote.invite.day${one}`),
              ])}
            />
          </FieldGroup>
        </form>
      )}
      {created === null && cloud !== undefined && (
        <CloudShare serviceId={cloud.serviceId} workspaceId={workspaceId} />
      )}
      <ResponsiveDialogFooter>
        <Button type="button" variant="ghost" onClick={manage}>
          {t("share.manage")}
        </Button>
        {created !== null ? (
          <Button type="button" onClick={onClose}>
            {t("share.done")}
          </Button>
        ) : (
          <Button
            type="submit"
            form="canvas-share-form"
            disabled={!ready && !create.isPending}
            loading={create.isPending}
          >
            {t("share.create")}
          </Button>
        )}
      </ResponsiveDialogFooter>
      <AddRelayDialog
        draft={signingIn ? { issuer: "", account: "", fingerprint: "" } : null}
        onClose={() => {
          setSigningIn(false);
          setWantRoute(false);
        }}
        onDone={() => {
          setSigningIn(false);
          void changed();
        }}
      />
    </>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange(value: string): void;
  placeholder?: string;
}) {
  return (
    <Field orientation="horizontal" className="justify-between">
      <FieldLabel>{label}</FieldLabel>
      <Select
        value={value}
        onValueChange={onChange}
        disabled={options.length === 0}
      >
        <SelectTrigger aria-label={label} className="w-[200px] min-w-0">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {options.map(([id, text]) => (
            <SelectItem key={id} value={id}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
