import * as React from "react";
import { ChevronsUpDown, Users } from "lucide-react";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { CLOUD_ROLES } from "@/lib/cloud-grant";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
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
import { Field, FieldLabel } from "@/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { tp } from "../i18n-plural";
import { useMembers, type TeamSpace } from "../team/data";
import { narrowedBy, type GrantChange } from "./access-model";
import { useHost, useHostAccess, type HostRow } from "./data";
import {
  useCreateGrant,
  useHostGrants,
  useUpdateGrant,
  type Grant,
  type GrantRole,
} from "./grants-data";

const DAY = 86_400_000;
const EXPIRIES = ["never", "d7", "d30", "d90"] as const;
const DAYS: Record<(typeof EXPIRIES)[number], number | null> = {
  never: null,
  d7: 7,
  d30: 30,
  d90: 90,
};
const KEEP = "keep";
const EVERYONE = "team";

/** 选一项的下拉（Popover + Command）：对象与主机共用。 */
function Choice({
  label,
  placeholder,
  search,
  empty,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  placeholder: string;
  search: string;
  empty: string;
  value: string | null;
  options: readonly { id: string; text: string; icon?: React.ReactNode }[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((entry) => entry.id === value);
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={label}
            disabled={disabled}
            className="min-w-0 justify-between"
          >
            <span className="truncate" translate="no">
              {current ? current.text : placeholder}
            </span>
            <ChevronsUpDown data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-[var(--z-dialog)] w-(--radix-popover-trigger-width) p-0"
        >
          <Command>
            <CommandInput placeholder={search} />
            <CommandList>
              <CommandEmpty>{empty}</CommandEmpty>
              <CommandGroup>
                {options.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.text}
                    data-checked={entry.id === value}
                    onSelect={() => {
                      onChange(entry.id);
                      setOpen(false);
                    }}
                  >
                    {entry.icon}
                    <span className="truncate" translate="no">
                      {entry.text}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

export function scopeText(
  t: ReturnType<typeof useT>,
  workspaceIds: readonly string[],
): string {
  return workspaceIds.length === 0
    ? t("cloud.hosts.scopeHost")
    : tp("cloud.hosts.scopeWorkspaces", workspaceIds.length);
}

/**
 * 添加或改一条授予（云端控制台 §3.3.5、§3.3.6）。控制台的授予范围是整台主机（§0 #5，D6：工作空间级
 * 只经客户端分享弹层）；已有范围的授予只改角色与到期，范围原样保留（云端更新是整体替换，不传就不动）。
 * 对象已有授予时就是更新（云端对已有的再建一条答 409）。会收窄某人有效权限的改动（合成降级、降角色、
 * 缩短到期）在按钮上改成「仍然…」，并列出受影响的人，由管理员确认。
 */
export function GrantDialog({
  space,
  hosts,
  sourceId: presetHost,
  subject: presetSubject,
  onClose,
}: {
  space: TeamSpace;
  /** 没有固定主机时供选的主机（授予页）。 */
  hosts?: readonly HostRow[];
  sourceId?: string;
  /** 固定对象：`"team"` 或账号号。 */
  subject?: string;
  onClose: () => void;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const list = React.useMemo(
    () => new Intl.ListFormat(locale, { style: "narrow", type: "conjunction" }),
    [locale],
  );
  const [sourceId, setSourceId] = React.useState(presetHost ?? "");
  const [subject, setSubject] = React.useState<string | null>(
    presetSubject ?? null,
  );
  const chosen = sourceId !== "";
  const host = useHost(space, sourceId, chosen);
  const access = useHostAccess(space, sourceId, chosen);
  const grants = useHostGrants(space, sourceId, chosen);
  const members = useMembers(space);
  const create = useCreateGrant(space);
  const update = useUpdateGrant(space);

  const ownerId =
    access.data?.access.find((row) => row.via === "owner")?.accountId ?? null;
  const staff = (members.data?.members ?? []).filter(
    (member) =>
      member.role !== "guest" &&
      member.role !== "billing" &&
      member.accountId !== ownerId,
  );
  const grantList = React.useMemo(
    () => grants.data?.grants ?? [],
    [grants.data],
  );
  const existing: Grant | undefined = grantList.find((grant) =>
    subject === EVERYONE
      ? grant.subject.kind === "team"
      : grant.subject.kind !== "team" &&
        grant.subject.kind !== "group" &&
        grant.subject.accountId === subject,
  );
  const name =
    subject === EVERYONE
      ? t("cloud.grants.everyone")
      : (members.data?.members.find((member) => member.accountId === subject)
          ?.displayName ?? "");

  const defaultRole = host.data?.settings?.defaultRole ?? "viewer";
  const [role, setRole] = React.useState<GrantRole | null>(null);
  const [expiry, setExpiry] = React.useState<string>(KEEP);
  const effectiveRole: GrantRole = role ?? existing?.role ?? defaultRole;
  // 已过期的授予不能「保持不变」（保持了仍然没有权限）：默认「永不」，也可以选一个新的到期。
  const lapsed =
    existing !== undefined &&
    existing.expiresAtMs !== null &&
    existing.expiresAtMs <= Date.now();
  const expiryChoice =
    expiry === KEEP && (existing === undefined || lapsed) ? "never" : expiry;

  const pickedExpiry: number | null | undefined =
    expiryChoice === KEEP
      ? undefined
      : DAYS[expiryChoice as keyof typeof DAYS] === null
        ? null
        : Date.now() + DAYS[expiryChoice as keyof typeof DAYS]! * DAY;

  const impact = React.useMemo(() => {
    if (subject === null || sourceId === "" || !grants.data) return [];
    const change: GrantChange | null = existing
      ? {
          kind: "update",
          grantId: existing.grantId,
          role: effectiveRole,
          ...(pickedExpiry === undefined ? {} : { expiresAtMs: pickedExpiry }),
        }
      : {
          kind: "add",
          subject:
            subject === EVERYONE
              ? { kind: "team", teamId: space.teamId }
              : { kind: "member", accountId: subject },
          role: effectiveRole,
          workspaceIds: [],
          expiresAtMs: pickedExpiry ?? null,
        };
    return narrowedBy({
      grants: grantList,
      members: members.data?.members ?? [],
      ownerId,
      change,
      now: Date.now(),
    });
    // 到期选项只影响「是否缩短」，用选项而不是实时时间做依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    subject,
    sourceId,
    grants.data,
    members.data,
    existing,
    effectiveRole,
    expiryChoice,
    ownerId,
    space.teamId,
  ]);

  const subjectOptions = [
    {
      id: EVERYONE,
      text: t("cloud.grants.everyone"),
      icon: <Users aria-hidden className="size-4" />,
    },
    ...staff.map((member) => ({
      id: member.accountId,
      text: member.displayName,
      icon: (
        <Avatar size="sm">
          <AvatarFallback>{[...member.displayName][0]}</AvatarFallback>
        </Avatar>
      ),
    })),
  ];

  const busy = create.isPending || update.isPending;
  // 成员与访问清单没到之前算不出谁会被收窄，不让提交（免得收窄提示消失）。
  const ready =
    sourceId !== "" &&
    subject !== null &&
    grants.isSuccess &&
    members.isSuccess &&
    access.isSuccess;

  const submit = async () => {
    if (!ready || subject === null) return;
    try {
      if (existing)
        await update.mutateAsync({
          grantId: existing.grantId,
          sourceId,
          role: effectiveRole,
          ...(pickedExpiry === undefined ? {} : { expiresAtMs: pickedExpiry }),
        });
      else
        await create.mutateAsync({
          sourceId,
          subject:
            subject === EVERYONE
              ? { kind: "team", teamId: space.teamId }
              : { kind: "member", accountId: subject },
          role: effectiveRole,
          ...(pickedExpiry ? { expiresAtMs: pickedExpiry } : {}),
        });
      toast.success(
        t(existing ? "cloud.grants.updated" : "cloud.grants.granted"),
      );
      onClose();
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  const lowers = impact.length > 0;
  const action = existing
    ? lowers
      ? "cloud.grants.lowersUpdate"
      : "cloud.grants.update"
    : lowers
      ? "cloud.grants.lowersGrant"
      : "cloud.grants.grant";

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {presetSubject !== undefined && name !== ""
              ? t("cloud.grants.editTitle", { name })
              : t("cloud.hosts.addAccess")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {presetHost === undefined ? (
            <Choice
              label={t("cloud.grants.host")}
              placeholder={t("cloud.grants.pickHost")}
              search={t("cloud.hosts.search")}
              empty={t("cloud.hosts.empty")}
              value={sourceId === "" ? null : sourceId}
              options={(hosts ?? []).map((row) => ({
                id: row.sourceId,
                text: row.name,
              }))}
              onChange={(id) => {
                setSourceId(id);
                setRole(null);
                setExpiry(KEEP);
              }}
            />
          ) : null}
          {presetSubject === undefined ? (
            <Choice
              label={t("cloud.grants.subject")}
              placeholder={t("cloud.grants.pickSubject")}
              search={t("cloud.grants.searchPeople")}
              empty={t("cloud.grants.noPeople")}
              value={subject}
              options={subjectOptions}
              disabled={sourceId === ""}
              onChange={(id) => {
                setSubject(id);
                setRole(null);
                setExpiry(KEEP);
              }}
            />
          ) : null}
          <Field>
            <FieldLabel>{t("cloud.hosts.access")}</FieldLabel>
            <RadioGroup
              value={effectiveRole}
              onValueChange={(value) => setRole(value as GrantRole)}
              aria-label={t("cloud.hosts.access")}
            >
              {CLOUD_ROLES.map((entry) => (
                <label
                  key={entry}
                  className="flex items-center gap-2 text-body"
                >
                  <RadioGroupItem value={entry} />
                  {t(`workspaceGroups.role.${entry}`)}
                </label>
              ))}
            </RadioGroup>
          </Field>
          {existing && existing.workspaceIds.length > 0 ? (
            <Field orientation="horizontal" className="justify-between">
              <FieldLabel>{t("cloud.hosts.scope")}</FieldLabel>
              <span className="text-body">
                {scopeText(t, existing.workspaceIds)}
              </span>
            </Field>
          ) : null}
          <Field>
            <FieldLabel>{t("cloud.hosts.expires")}</FieldLabel>
            <Select value={expiryChoice} onValueChange={setExpiry}>
              <SelectTrigger aria-label={t("cloud.hosts.expires")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {existing && !lapsed ? (
                  <SelectItem value={KEEP}>
                    {t("cloud.grants.expiry.keep")}
                  </SelectItem>
                ) : null}
                {EXPIRIES.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(`cloud.grants.expiry.${entry}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {lowers ? (
            <Alert variant="destructive" data-slot="grant-lowers">
              <AlertTitle>
                {t("cloud.grants.lowers", {
                  names: list.format(
                    impact.map((member) => member.displayName),
                  ),
                })}
              </AlertTitle>
            </Alert>
          ) : null}
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button
              type="submit"
              variant={lowers ? "destructive-solid" : "default"}
              loading={busy}
              disabled={!ready}
            >
              {t(action)}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
