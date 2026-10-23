import * as React from "react";

import { useT } from "@/app/preferences-store";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SkeletonSettings } from "@/ui/skeletons";
import { Switch } from "@/ui/switch";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { navigate } from "../router";
import { PageHeader } from "../shell/PageHeader";
import type { TeamRole } from "../shell/model";
import { ConfirmAction } from "../ui/ConfirmAction";
import { InlineError } from "../ui/InlineError";
import { TypedConfirm } from "../ui/TypedConfirm";
import {
  useDeleteTeam,
  useLeaveTeam,
  useMembers,
  useRenameTeam,
  useTeamSettings,
  useTransferOwnership,
  useUpdateSettings,
  type TeamSettings,
  type TeamSpace,
} from "./data";
import { teamCaps } from "./roles";

const HOST_ROLES = ["viewer", "editor", "operator", "driver"] as const;
const ENDORSERS = ["owner", "owner_admin"] as const;

type BooleanSetting =
  | "membersCanRegisterHosts"
  | "allowGuests"
  | "allowAnonymousLinks"
  | "memberSelfEndorse";

function GeneralGroup({ space, name }: { space: TeamSpace; name: string }) {
  const t = useT();
  const rename = useRenameTeam(space);
  const [draft, setDraft] = React.useState<string | null>(null);
  const id = React.useId();
  const save = async () => {
    const next = (draft ?? name).trim();
    if (next === "" || next === name) {
      setDraft(null);
      return;
    }
    // 保存结束前一直显示输入的值，免得先闪回旧名字。
    try {
      await rename.mutateAsync(next);
      toast.success(t("cloud.common.saved"));
    } catch (failure) {
      toast.error(describeFailure(failure));
    } finally {
      setDraft(null);
    }
  };
  return (
    <SettingsGroup title={t("cloud.team.settingsGeneral")}>
      <SettingsRow label={<label htmlFor={id}>{t("cloud.team.name")}</label>}>
        <Input
          id={id}
          className="w-56"
          value={draft ?? name}
          maxLength={128}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </SettingsRow>
      <SettingsRow label={t("cloud.team.slug")}>
        <span className="text-muted-foreground" translate="no">
          {`${window.location.host}/t/${space.slug}`}
        </span>
      </SettingsRow>
    </SettingsGroup>
  );
}

function AccessGroup({ space }: { space: TeamSpace }) {
  const t = useT();
  const settings = useTeamSettings(space);
  const update = useUpdateSettings(space);
  if (settings.isPending) return <SkeletonSettings rows={6} />;
  if (settings.isError)
    return (
      <InlineError
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  const value = settings.data;
  const save = (patch: Partial<TeamSettings>) =>
    update.mutate(patch, {
      onSuccess: () => toast.success(t("cloud.common.saved")),
      onError: (failure) => toast.error(describeFailure(failure)),
    });
  const toggle = (key: BooleanSetting, label: string) => (
    <SettingsRow label={label}>
      <Switch
        aria-label={label}
        checked={value[key]}
        onCheckedChange={(checked) => save({ [key]: checked })}
      />
    </SettingsRow>
  );
  return (
    <SettingsGroup title={t("cloud.team.settingsAccess")}>
      {toggle("membersCanRegisterHosts", t("cloud.team.memberRegister"))}
      <SettingsRow label={t("cloud.team.defaultRole")}>
        <Select
          value={value.defaultHostRole}
          onValueChange={(next) =>
            save({ defaultHostRole: next as (typeof HOST_ROLES)[number] })
          }
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            aria-label={t("cloud.team.defaultRole")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {HOST_ROLES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(`workspaceGroups.role.${entry}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {toggle("allowGuests", t("cloud.team.allowGuests"))}
      {toggle("allowAnonymousLinks", t("cloud.team.allowAnonLinks"))}
      <SettingsRow label={t("cloud.team.endorsers")}>
        <Select
          value={value.deviceEndorsers}
          onValueChange={(next) =>
            save({ deviceEndorsers: next as (typeof ENDORSERS)[number] })
          }
        >
          <SelectTrigger
            size="sm"
            className="w-48"
            aria-label={t("cloud.team.endorsers")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {ENDORSERS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(
                  entry === "owner"
                    ? "cloud.team.endorsersOwner"
                    : "cloud.team.endorsersOwnerAdmin",
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {toggle("memberSelfEndorse", t("cloud.team.selfEndorse"))}
    </SettingsGroup>
  );
}

/** 转移所有权：选一位管理员即弹确认（对象名重复在标题里）；没有管理员就没有这一行。 */
function TransferRow({
  space,
  teamName,
}: {
  space: TeamSpace;
  teamName: string;
}) {
  const t = useT();
  const members = useMembers(space);
  const transfer = useTransferOwnership(space);
  const [target, setTarget] = React.useState<{
    accountId: string;
    name: string;
  } | null>(null);
  const admins = (members.data?.members ?? []).filter(
    (row) => row.role === "admin",
  );
  if (admins.length === 0) return null;
  return (
    <>
      <SettingsRow label={t("cloud.team.transfer")}>
        <Select
          value=""
          onValueChange={(accountId) => {
            const found = admins.find((row) => row.accountId === accountId);
            if (found) setTarget({ accountId, name: found.displayName });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-48"
            aria-label={t("cloud.team.transferTo")}
          >
            <SelectValue placeholder={t("cloud.team.transferTo")} />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {admins.map((row) => (
              <SelectItem key={row.accountId} value={row.accountId}>
                {row.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <ConfirmAction
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t("cloud.team.transferTitle", {
          team: teamName,
          name: target?.name ?? "",
        })}
        actionLabel={t("cloud.team.transferAction")}
        onConfirm={async () => {
          if (!target) return;
          try {
            await transfer.mutateAsync(target.accountId);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.team.transferred"));
        }}
      />
    </>
  );
}

function DangerGroup({
  space,
  teamName,
  role,
}: {
  space: TeamSpace;
  teamName: string;
  role: TeamRole;
}) {
  const t = useT();
  const caps = teamCaps(role);
  const leave = useLeaveTeam(space);
  const remove = useDeleteTeam(space);
  const [dialog, setDialog] = React.useState<"leave" | "delete" | null>(null);
  return (
    <SettingsGroup title={t("cloud.common.dangerZone")}>
      {caps.transfer ? <TransferRow space={space} teamName={teamName} /> : null}
      {caps.leave ? (
        <SettingsRow label={t("cloud.team.leave")}>
          <Button variant="outline" onClick={() => setDialog("leave")}>
            {t("cloud.team.leave")}
          </Button>
        </SettingsRow>
      ) : null}
      {caps.delete ? (
        <SettingsRow label={t("cloud.team.delete")}>
          <Button variant="destructive" onClick={() => setDialog("delete")}>
            {t("cloud.team.delete")}
          </Button>
        </SettingsRow>
      ) : null}
      <ConfirmAction
        open={dialog === "leave"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("cloud.team.leaveTitle", { team: teamName })}
        actionLabel={t("cloud.team.leaveAction")}
        onConfirm={async () => {
          try {
            await leave.mutateAsync();
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.team.left"));
          navigate("/me", { replace: true });
        }}
      />
      <TypedConfirm
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("cloud.team.deleteTitle", { team: teamName })}
        expected={space.slug}
        actionLabel={t("cloud.team.deleteAction")}
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
          } catch (failure) {
            toast.error(
              toCloudError(failure).code === "conflict"
                ? t("cloud.team.deleteBlocked")
                : describeFailure(failure),
            );
            throw failure;
          }
          toast.success(t("cloud.team.deleted"));
        }}
      />
    </SettingsGroup>
  );
}

/**
 * 团队 · 设置（云端控制台 §3.3.12，M1）：常规、访问两组改动即存（owner / admin），危险操作
 * 按角色——转移与删除只有 owner，「离开团队」每个角色都有。安全组（M2）与域名（M3）还没有。
 */
export function SettingsPage({
  space,
  teamName,
  role,
}: {
  space: TeamSpace;
  teamName: string;
  role: TeamRole;
}) {
  const t = useT();
  const caps = teamCaps(role);
  return (
    <>
      <PageHeader title={t("cloud.nav.settings")} />
      <div className="flex flex-col gap-6">
        {caps.editSettings ? (
          <>
            <GeneralGroup space={space} name={teamName} />
            <AccessGroup space={space} />
          </>
        ) : null}
        <DangerGroup space={space} teamName={teamName} role={role} />
      </div>
    </>
  );
}
