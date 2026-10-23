import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Trash2 } from "lucide-react";

import {
  type CloudAccess,
  type CloudGrant,
  cloudAccess,
  cloudGrantCreate,
  cloudGrantRevoke,
  cloudGrantUpdate,
  cloudInvite,
} from "@/api/remote-services";
import { RuntimeRequestError } from "@/api/request";
import { useT } from "@/app/preferences-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Button } from "@/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/command";
import { Field, FieldGroup, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/ui/input-group";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { COMMAND_INPUT_FOCUS } from "@/panels/tabs-focus";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Separator } from "@/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { toast } from "@/ui/toast";
import {
  CLOUD_ROLES,
  type CloudRole,
  lowersEffectiveRole,
  rankOf,
  updateNarrows,
} from "@/lib/cloud-grant";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 弹层里给的权限；「可接管」只在设置里给（#301），已有的接管授予仍照常显示。 */
const DIALOG_ROLES = ["viewer", "editor", "operator"] as const;
/** 授予 / 邀请的到期：缺省 7 天，云端至多 30 天。 */
const EXPIRY_DAYS = [7, 1, 30] as const;

type Target = CloudAccess["members"][number];
type Range = "workspace" | "host";

export const cloudAccessKey = (serviceId: string) =>
  ["cloud-access", serviceId] as const;

const QUOTA_KEYS = new Set([
  "hosts",
  "members",
  "guests",
  "connections",
  "traffic",
  "teams",
]);

/** 授予与邀请的错误：按 `code` 取文案；会降低已有角色的 `conflict` 与配额各有一句。 */
function failureText(
  t: ReturnType<typeof useT>,
  error: unknown,
  during: "grant" | "invite" = "grant",
): string {
  if (error instanceof RuntimeRequestError) {
    if (error.code === "conflict")
      return t(
        during === "invite"
          ? "share.cloud.inviteConflict"
          : "share.cloud.conflict",
      );
    if (error.code === "limit_reached") {
      const quota = (error.body as { details?: { quota?: unknown } } | null)
        ?.details?.quota;
      if (typeof quota === "string" && QUOTA_KEYS.has(quota))
        return t(`cloud.billing.limit.${quota}`);
    }
  }
  return error instanceof Error ? error.message : t("error.internal");
}

/** 待确认的提示：哪种操作会降低谁的有效角色。 */
interface Warning {
  readonly kind: "update" | "invite" | "row";
  readonly member: Target;
  /** `row`：行里降级的那条授予与新角色。 */
  readonly grantId?: string;
  readonly role?: CloudRole;
}

/** 这个账号在这台主机上的授予（成员 / 访客）。 */
function grantsOf(
  data: CloudAccess | undefined,
  accountId: string,
): CloudGrant[] {
  return (data?.grants ?? []).filter((one) => subjectId(one) === accountId);
}

function nameOf(member: Target): string {
  return member.displayName || member.email || member.accountId.slice(0, 8);
}

function subjectId(grant: CloudGrant): string {
  return grant.subject.kind === "member" || grant.subject.kind === "guest"
    ? grant.subject.accountId
    : "";
}

/**
 * 分享弹层里 Armadra 云的一组（云端控制台 §3.5.2）：只在本机已登记到 Armadra 云时
 * 渲染。成员授予（团队主机）、按邮箱邀请，以及已授予的人（改权限、移除）。授予的范围
 * 是此工作空间或整台主机；会话范围云端授予不支持，仍用上面的分享链接。
 *
 * 云端对已经有授予的人再新建一条一律 `conflict`（不合成），所以选中的成员已有授予时，
 * 主按钮是「更新」，把角色 / 范围 / 到期改成表单里的值；合成只发生在主机邀请被接受时
 * （范围并集、角色取覆盖全部范围的最高角色，#112），所以更宽而更低的邀请会降低邮箱
 * 对应成员的有效角色、被云端拒绝。降低角色的更新与这样的邀请，提交前先提示管理员确认。
 */
export function CloudShare({
  serviceId,
  workspaceId,
}: {
  serviceId: string;
  workspaceId: string;
}) {
  const t = useT();
  const client = useQueryClient();
  const access = useQuery({
    queryKey: cloudAccessKey(serviceId),
    queryFn: () => cloudAccess(serviceId),
    retry: false,
  });
  const data = access.data;
  const [role, setRole] = React.useState<CloudRole>("viewer");
  const [range, setRange] = React.useState<Range>("workspace");
  const [days, setDays] = React.useState<number>(7);
  // 更新已有授予时，到期只在管理员明确改过才传（缺省 7 天不覆盖他原来的到期）。
  const [daysTouched, setDaysTouched] = React.useState(false);
  const [removing, setRemoving] = React.useState<{
    grantId: string;
    name: string;
  } | null>(null);
  const [picked, setPicked] = React.useState<Target | null>(null);
  const [email, setEmail] = React.useState("");
  const [confirming, setConfirming] = React.useState<Warning | null>(null);

  const refresh = () =>
    client.invalidateQueries({ queryKey: cloudAccessKey(serviceId) });
  const team = data?.space.kind === "team";
  const knownByEmail = (address: string) =>
    data?.members.find(
      (one) =>
        one.email !== "" && one.email.toLowerCase() === address.toLowerCase(),
    );
  // 团队主机上，访客的授予与非成员的邀请必须限定工作空间（云端 `workspaceIds` 不能为空）。
  const wholeBlocked =
    team &&
    (picked?.role === "guest" ||
      (email.trim() !== "" && knownByEmail(email.trim()) === undefined));
  const effectiveRange: Range = wholeBlocked ? "workspace" : range;
  const workspaceIds = effectiveRange === "workspace" ? [workspaceId] : [];
  /** 更新已有授予的新范围：只放宽——已有整台保持整台，否则并上当前工作空间。 */
  const updatedScope = (held: CloudGrant): string[] =>
    held.workspaceIds.length === 0 || effectiveRange === "host"
      ? []
      : [...new Set([...held.workspaceIds, workspaceId])];
  const expiresAtMs = () => Date.now() + days * DAY_MS;

  const grant = useMutation({
    mutationFn: (target: Target) => {
      const held = grantsOf(data, target.accountId)[0];
      return held === undefined
        ? cloudGrantCreate({
            serviceId,
            subject: {
              kind: target.role === "guest" ? "guest" : "member",
              accountId: target.accountId,
            },
            role,
            workspaceIds,
            expiresAtMs: expiresAtMs(),
          })
        : cloudGrantUpdate({
            serviceId,
            grantId: held.grantId,
            role,
            workspaceIds: updatedScope(held),
            ...(daysTouched ? { expiresAtMs: expiresAtMs() } : {}),
          });
    },
    onSuccess: (_value, target) => {
      setConfirming(null);
      setPicked(null);
      setDaysTouched(false);
      toast.success(t("share.cloud.granted", { name: nameOf(target) }));
      void refresh();
    },
    onError: (error: unknown) => toast.error(failureText(t, error)),
  });
  const invite = useMutation({
    mutationFn: (address: string) =>
      cloudInvite({
        serviceId,
        email: address,
        role,
        workspaceIds,
        expiresAtMs: expiresAtMs(),
      }),
    onSuccess: ({ invitation }) => {
      setConfirming(null);
      setEmail("");
      toast.success(t("share.cloud.invited", { email: invitation.email }));
      void refresh();
    },
    onError: (error: unknown) => toast.error(failureText(t, error, "invite")),
  });
  const update = useMutation({
    mutationFn: (input: { grantId: string; role: CloudRole }) =>
      cloudGrantUpdate({ serviceId, ...input }),
    onSuccess: () => void refresh(),
    onError: (error: unknown) => toast.error(failureText(t, error)),
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => cloudGrantRevoke(serviceId, grantId),
    onSuccess: () => void refresh(),
    onError: (error: unknown) => toast.error(failureText(t, error)),
  });

  if (data === undefined || !data.canManage) return null;

  const members = data.members;
  const names = new Map(members.map((one) => [one.accountId, nameOf(one)]));
  const listed = data.grants.filter(
    (one) =>
      (one.subject.kind === "member" || one.subject.kind === "guest") &&
      (one.workspaceIds.length === 0 || one.workspaceIds.includes(workspaceId)),
  );

  function submitGrant(target: Target) {
    const held = grantsOf(data, target.accountId);
    const first = held[0];
    let lowers = false;
    if (first !== undefined) {
      // 已有授予时是更新：角色更低、范围更小或到期更早，都会收窄他的有效权限（共享规则）。
      lowers = updateNarrows(
        held,
        first,
        {
          role,
          workspaceIds: updatedScope(first),
          ...(daysTouched ? { expiresAtMs: expiresAtMs() } : {}),
        },
        Date.now(),
      );
    }
    if (lowers && confirming?.kind !== "update") {
      setConfirming({ kind: "update", member: target });
      return;
    }
    grant.mutate(target);
  }

  function submitInvite(address: string) {
    // 邮箱对应团队里已有授予的成员：按合成规则预判这张邀请会不会降低他的有效角色。
    const known = knownByEmail(address);
    const lowers =
      known !== undefined &&
      lowersEffectiveRole(
        grantsOf(data, known.accountId),
        { role, workspaceIds },
        Date.now(),
      );
    if (lowers && confirming?.kind !== "invite") {
      setConfirming({ kind: "invite", member: known });
      return;
    }
    invite.mutate(address);
  }

  const inviteReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canInvite = !team || data.allowGuests;

  function onRowRole(row: CloudGrant, name: string, next: CloudRole) {
    if (rankOf(next) < rankOf(row.role)) {
      setConfirming({
        kind: "row",
        member: {
          accountId: subjectId(row),
          displayName: name,
          email: "",
          role: "",
        },
        grantId: row.grantId,
        role: next,
      });
      return;
    }
    update.mutate({ grantId: row.grantId, role: next });
  }

  return (
    <div data-slot="share-cloud" className="flex min-w-0 flex-col gap-4">
      <Separator />
      <FieldGroup className="gap-4">
        <Field orientation="horizontal" className="justify-between">
          <FieldLabel>{t("share.cloud.title")}</FieldLabel>
        </Field>
        <Pick
          label={t("sharing.scope")}
          value={effectiveRange}
          onChange={(value) => {
            setRange(value as Range);
            setConfirming(null);
          }}
          options={[
            ["workspace", t("share.scope.workspace")],
            ["host", t("share.cloud.scope.host"), wholeBlocked],
          ]}
        />
        <Pick
          label={t("remote.invite.role")}
          value={role}
          onChange={(value) => {
            setRole(value as CloudRole);
            setConfirming(null);
          }}
          options={DIALOG_ROLES.map((one) => [
            one,
            t(`workspaceGroups.role.${one}`),
          ])}
        />
        <Pick
          label={t("remote.invite.expires")}
          value={String(days)}
          onChange={(value) => {
            setDays(Number(value));
            setDaysTouched(true);
          }}
          options={EXPIRY_DAYS.map((one) => [
            String(one),
            t(`remote.invite.day${one}`),
          ])}
        />
        {team && members.length > 0 && (
          <Field orientation="horizontal" className="gap-2">
            <MemberPicker
              members={members}
              value={picked}
              onChange={(next) => {
                setPicked(next);
                setConfirming(null);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={picked === null || grant.isPending}
              loading={grant.isPending}
              onClick={() => picked !== null && submitGrant(picked)}
            >
              {picked !== null && grantsOf(data, picked.accountId).length > 0
                ? t("share.cloud.update")
                : t("share.cloud.grant")}
            </Button>
          </Field>
        )}
        {confirming !== null && (
          <Alert variant="destructive" data-slot="share-cloud-lowers">
            <AlertTitle>
              {t(
                confirming.kind === "invite"
                  ? "share.cloud.lowers.invite"
                  : "share.cloud.lowers.update",
                { name: nameOf(confirming.member) },
              )}
            </AlertTitle>
            <div className="flex justify-end pt-1.5">
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={grant.isPending || invite.isPending}
                onClick={() => {
                  if (confirming.kind === "update")
                    grant.mutate(confirming.member);
                  else if (confirming.kind === "invite")
                    invite.mutate(email.trim());
                  else if (confirming.grantId && confirming.role) {
                    update.mutate({
                      grantId: confirming.grantId,
                      role: confirming.role,
                    });
                    setConfirming(null);
                  }
                }}
              >
                {t(
                  confirming.kind === "invite"
                    ? "share.cloud.lowers.confirmInvite"
                    : "share.cloud.lowers.confirm",
                )}
              </Button>
            </div>
          </Alert>
        )}
        {canInvite && (
          <Field>
            <InputGroup>
              <InputGroupInput
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("share.cloud.email")}
                placeholder={t("share.cloud.email")}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setConfirming(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && inviteReady) {
                    event.preventDefault();
                    submitInvite(email.trim());
                  }
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  variant="secondary"
                  disabled={!inviteReady || invite.isPending}
                  onClick={() => submitInvite(email.trim())}
                >
                  {t("share.cloud.invite")}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        )}
      </FieldGroup>
      {listed.length > 0 && (
        <ul
          aria-label={t("share.cloud.granted.list")}
          className="flex min-w-0 flex-col gap-2"
        >
          {listed.map((one) => (
            <GrantRow
              key={one.grantId}
              grant={one}
              name={names.get(subjectId(one)) ?? subjectId(one).slice(0, 8)}
              onRole={(next) =>
                onRowRole(
                  one,
                  names.get(subjectId(one)) ?? subjectId(one).slice(0, 8),
                  next,
                )
              }
              onRemove={() =>
                setRemoving({
                  grantId: one.grantId,
                  name: names.get(subjectId(one)) ?? subjectId(one).slice(0, 8),
                })
              }
            />
          ))}
        </ul>
      )}
      <ResponsiveAlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("share.cloud.revokeConfirm", { name: removing?.name ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("remote.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing !== null) revoke.mutate(removing.grantId);
                setRemoving(null);
              }}
            >
              {t("share.cloud.revokeAction")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  );
}

function GrantRow({
  grant,
  name,
  onRole,
  onRemove,
}: {
  grant: CloudGrant;
  name: string;
  onRole(role: CloudRole): void;
  onRemove(): void;
}) {
  const t = useT();
  const roles: readonly CloudRole[] = DIALOG_ROLES.includes(
    grant.role as (typeof DIALOG_ROLES)[number],
  )
    ? DIALOG_ROLES
    : CLOUD_ROLES;
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Avatar size="sm">
        <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-body">
        {name}
        {grant.workspaceIds.length === 0 && ` · ${t("share.cloud.scope.host")}`}
      </span>
      <Select
        value={grant.role}
        onValueChange={(value) => onRole(value as CloudRole)}
      >
        <SelectTrigger
          size="sm"
          aria-label={`${name} · ${t("remote.invite.role")}`}
          className="w-[120px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {roles.map((one) => (
            <SelectItem key={one} value={one}>
              {t(`workspaceGroups.role.${one}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <IconButton
        size="cluster"
        label={t("share.cloud.revoke", { name })}
        onClick={onRemove}
      >
        <Trash2 />
      </IconButton>
    </li>
  );
}

function MemberPicker({
  members,
  value,
  onChange,
}: {
  members: readonly Target[];
  value: Target | null;
  onChange(next: Target | null): void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t("share.cloud.member")}
          className="min-w-0 flex-1 justify-between"
        >
          <span className="truncate">
            {value === null ? t("share.cloud.member.pick") : nameOf(value)}
          </span>
          <ChevronsUpDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[var(--z-dialog)] w-(--radix-popover-trigger-width) p-0"
      >
        <Command>
          <CommandInput
            className={COMMAND_INPUT_FOCUS}
            placeholder={t("share.cloud.member.search")}
          />
          <CommandList>
            <CommandEmpty>{t("share.cloud.member.none")}</CommandEmpty>
            <CommandGroup>
              {members.map((member) => (
                <CommandItem
                  key={member.accountId}
                  value={`${nameOf(member)} ${member.email}`}
                  data-checked={value?.accountId === member.accountId}
                  onSelect={() => {
                    onChange(member);
                    setOpen(false);
                  }}
                >
                  <Avatar size="sm">
                    <AvatarFallback>
                      {nameOf(member).slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{nameOf(member)}</span>
                  {member.role === "guest" && (
                    <span className="text-meta text-muted-foreground">
                      {t("share.cloud.guest")}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Pick({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string, boolean?])[];
  onChange(value: string): void;
}) {
  return (
    <Field orientation="horizontal" className="justify-between">
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="w-[200px] min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {options.map(([id, text, disabled]) => (
            <SelectItem key={id} value={id} disabled={disabled === true}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
