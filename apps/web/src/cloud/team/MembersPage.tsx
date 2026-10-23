import * as React from "react";
import { Ellipsis } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { useMe } from "../personal/account-data";
import { navigate, type RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import type { TeamRole } from "../shell/model";
import { ConfirmAction } from "../ui/ConfirmAction";
import { DataList, type DataColumn } from "../ui/DataList";
import { InlineError } from "../ui/InlineError";
import { PageState } from "../ui/PageState";
import { RelativeTime } from "../ui/RelativeTime";
import { spaceBase } from "../space";
import {
  useChangeRole,
  useLeaveTeam,
  useMembers,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useTeamInvitations,
  useTeamSettings,
  type TeamInvitation,
  type TeamMember,
  type TeamSpace,
} from "./data";
import { InviteDialog } from "./InviteDialog";
import { INVITE_ROLES, teamCaps, type TeamCaps } from "./roles";

const TABS = ["members", "guests", "invitations"] as const;
type Tab = (typeof TABS)[number];

const TAB_KEY: Record<Tab, string> = {
  members: "cloud.team.members",
  guests: "cloud.team.guests",
  invitations: "cloud.team.invitations",
};

const roleLabel = (t: ReturnType<typeof useT>, role: string) =>
  t(`cloud.team.role.${role}`);

function Person({ member }: { member: TeamMember }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar size="sm">
        <AvatarFallback>{[...member.displayName][0]}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate" translate="no">
        {member.displayName}
      </span>
    </span>
  );
}

/** 可改时是行内 `Select`，不可改（owner、权限不够）是文字（§3.0 权限）。 */
function RoleCell({
  space,
  member,
  caps,
  guestsAllowed,
}: {
  space: TeamSpace;
  member: TeamMember;
  caps: TeamCaps;
  guestsAllowed: boolean;
}) {
  const t = useT();
  const change = useChangeRole(space);
  if (!caps.canChangeRole(member.role))
    return <Badge variant="secondary">{roleLabel(t, member.role)}</Badge>;
  return (
    <Select
      value={member.role}
      disabled={change.isPending}
      onValueChange={(value) => {
        change.mutate(
          {
            accountId: member.accountId,
            role: value as (typeof INVITE_ROLES)[number],
          },
          {
            onSuccess: () => toast.success(t("cloud.common.saved")),
            onError: (failure) => toast.error(describeFailure(failure)),
          },
        );
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-32"
        aria-label={t("cloud.team.roleOf", { name: member.displayName })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="z-[var(--z-dialog)]">
        {INVITE_ROLES.filter(
          (entry) =>
            entry !== "guest" || guestsAllowed || member.role === "guest",
        ).map((entry) => (
          <SelectItem key={entry} value={entry}>
            {roleLabel(t, entry)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MemberMenu({
  space,
  teamName,
  member,
  self,
  caps,
}: {
  space: TeamSpace;
  teamName: string;
  member: TeamMember;
  self: boolean;
  caps: TeamCaps;
}) {
  const t = useT();
  const remove = useRemoveMember(space);
  const leave = useLeaveTeam(space);
  const [dialog, setDialog] = React.useState<"remove" | "leave" | null>(null);
  const canRemove = !self && caps.canRemove(member.role);
  const canLeave = self && caps.leave;
  if (!canRemove && !canLeave) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="cluster"
            label={t("cloud.common.actionsFor", { name: member.displayName })}
            className="pointer-coarse:size-11"
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRemove ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDialog("remove")}
            >
              {t("cloud.team.remove")}
            </DropdownMenuItem>
          ) : null}
          {canLeave ? (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDialog("leave")}
            >
              {t("cloud.team.leave")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmAction
        open={dialog === "remove"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t("cloud.team.removeTitle", { name: member.displayName })}
        actionLabel={t("cloud.team.removeAction")}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(member.accountId);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.team.removed"));
        }}
      />
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
    </>
  );
}

function MembersTable({
  space,
  teamName,
  rows,
  caps,
  selfId,
  guests,
  guestsAllowed,
}: {
  space: TeamSpace;
  teamName: string;
  rows: readonly TeamMember[];
  caps: TeamCaps;
  selfId: string | undefined;
  guests: boolean;
  guestsAllowed: boolean;
}) {
  const t = useT();
  const columns = React.useMemo<DataColumn<TeamMember>[]>(
    () => [
      {
        id: "name",
        header: t("cloud.team.name"),
        role: "primary",
        cell: (row) => <Person member={row} />,
      },
      {
        id: "email",
        header: t("cloud.team.inviteEmails"),
        role: "sub",
        cell: (row) => <span translate="no">{row.email}</span>,
      },
      {
        id: "role",
        header: t("cloud.team.role"),
        role: "trailing",
        cell: (row) => (
          <RoleCell
            space={space}
            member={row}
            caps={caps}
            guestsAllowed={guestsAllowed}
          />
        ),
      },
      ...(guests
        ? [
            {
              id: "reachable",
              header: t("cloud.team.reachableHosts"),
              numeric: true,
              cell: (row: TeamMember) => row.reachableHosts ?? 0,
            },
          ]
        : []),
      {
        id: "joined",
        header: t("cloud.team.joined"),
        cell: (row) => <RelativeTime ms={row.joinedAtMs} />,
      },
    ],
    [t, space, caps, guests, guestsAllowed],
  );
  return (
    <DataList
      caption={t(guests ? "cloud.team.guests" : "cloud.team.members")}
      rows={rows}
      columns={columns}
      rowKey={(row) => row.accountId}
      actionsHeader={t("cloud.common.actionsFor", {
        name: t("cloud.team.members"),
      })}
      actions={(row) => (
        <MemberMenu
          space={space}
          teamName={teamName}
          member={row}
          self={row.accountId === selfId}
          caps={caps}
        />
      )}
    />
  );
}

function InvitationMenu({
  space,
  invitation,
}: {
  space: TeamSpace;
  invitation: TeamInvitation;
}) {
  const t = useT();
  const resend = useResendInvitation(space);
  const revoke = useRevokeInvitation(space);
  const [confirm, setConfirm] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="cluster"
            label={t("cloud.common.actionsFor", { name: invitation.email })}
            className="pointer-coarse:size-11"
          >
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() =>
              resend.mutate(invitation.invitationId, {
                onSuccess: () => toast.success(t("cloud.team.resent")),
                onError: (failure) => toast.error(describeFailure(failure)),
              })
            }
          >
            {t("cloud.team.resend")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirm(true)}
          >
            {t("cloud.team.revokeInvite")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        title={t("cloud.team.revokeInviteTitle", { email: invitation.email })}
        actionLabel={t("cloud.team.revokeInvite")}
        onConfirm={async () => {
          try {
            await revoke.mutateAsync(invitation.invitationId);
          } catch (failure) {
            toast.error(describeFailure(failure));
            throw failure;
          }
          toast.success(t("cloud.team.revoked"));
        }}
      />
    </>
  );
}

function InvitationsTab({
  space,
  members,
  onInvite,
}: {
  space: TeamSpace;
  members: readonly TeamMember[];
  onInvite: () => void;
}) {
  const t = useT();
  const invitations = useTeamInvitations(space);
  const names = React.useMemo(
    () => new Map(members.map((row) => [row.accountId, row.displayName])),
    [members],
  );
  const rows = React.useMemo(
    () =>
      (invitations.data?.invitations ?? []).filter(
        (row) => row.state === "pending" || row.state === "expired",
      ),
    [invitations.data],
  );
  const columns = React.useMemo<DataColumn<TeamInvitation>[]>(
    () => [
      {
        id: "email",
        header: t("cloud.team.inviteEmails"),
        role: "primary",
        cell: (row) => <span translate="no">{row.email}</span>,
      },
      {
        id: "state",
        header: t("cloud.hosts.status"),
        role: "trailing",
        cell: (row) =>
          row.state === "expired" ? (
            <Badge variant="ghost">{t("cloud.common.expired")}</Badge>
          ) : (
            <Badge variant="outline">{t("cloud.team.pendingBadge")}</Badge>
          ),
      },
      {
        id: "role",
        header: t("cloud.team.role"),
        cell: (row) =>
          row.teamRole ? (
            <Badge variant="secondary">{roleLabel(t, row.teamRole)}</Badge>
          ) : null,
      },
      {
        id: "invitedBy",
        header: t("cloud.team.invitedBy"),
        cell: (row) => (
          <span translate="no">
            {names.get(row.invitedBy) ?? row.invitedBy}
          </span>
        ),
      },
      {
        id: "expires",
        header: t("cloud.team.expires"),
        cell: (row) => <RelativeTime ms={row.expiresAtMs} />,
      },
    ],
    [t, names],
  );
  if (invitations.isPending)
    return (
      <SkeletonTable rows={3} columns={5} label={t("cloud.team.invitations")} />
    );
  if (invitations.isError)
    return (
      <InlineError
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
      />
    );
  if (rows.length === 0)
    return (
      <EmptyState title={t("cloud.team.emptyInvites")}>
        <Button onClick={onInvite}>{t("cloud.team.invite")}</Button>
      </EmptyState>
    );
  return (
    <DataList
      caption={t("cloud.team.invitations")}
      rows={rows}
      columns={columns}
      rowKey={(row) => row.invitationId}
      actionsHeader={t("cloud.common.actionsFor", {
        name: t("cloud.team.invitations"),
      })}
      actions={(row) => <InvitationMenu space={space} invitation={row} />}
    />
  );
}

/**
 * 团队 · 成员与邀请（云端控制台 §3.3.2）：成员 / 访客 / 邀请三个页签（`?tab=`），邀请页签和
 * 「邀请成员」只有 owner / admin 有；member、billing 只读。
 */
export function MembersPage({
  match,
  space,
  teamName,
  role,
}: {
  match: RouteMatch;
  space: TeamSpace;
  teamName: string;
  role: TeamRole;
}) {
  const t = useT();
  const caps = React.useMemo(() => teamCaps(role), [role]);
  const members = useMembers(space);
  const settings = useTeamSettings(space, caps.editSettings);
  const guestsAllowed = settings.data?.allowGuests !== false;
  const me = useMe();
  const [inviting, setInviting] = React.useState(false);
  const tabs = TABS.filter(
    (entry) => entry !== "invitations" || caps.manageInvitations,
  );
  const requested = match.query.get("tab");
  const tab: Tab = tabs.find((entry) => entry === requested) ?? "members";

  if (members.isError && !members.data)
    return (
      <>
        <PageHeader title={t("cloud.nav.members")} />
        <PageState
          code={toCloudError(members.error).code}
          onRetry={() => void members.refetch()}
          onHome={() => navigate(spaceBase(space))}
        />
      </>
    );

  const all = members.data?.members ?? [];
  const staff = all.filter((row) => row.role !== "guest");
  const guests = all.filter((row) => row.role === "guest");
  const selfId = me.data?.accountId;
  const body = (rows: readonly TeamMember[], onlyGuests: boolean) =>
    members.isPending ? (
      <SkeletonTable
        rows={4}
        columns={4}
        label={t(onlyGuests ? "cloud.team.guests" : "cloud.team.members")}
      />
    ) : rows.length === 0 ? (
      <EmptyState title={t("cloud.team.emptyGuests")} />
    ) : (
      <MembersTable
        space={space}
        teamName={teamName}
        rows={rows}
        caps={caps}
        selfId={selfId}
        guests={onlyGuests}
        guestsAllowed={guestsAllowed}
      />
    );

  return (
    <>
      <PageHeader
        title={t("cloud.nav.members")}
        action={
          caps.manageInvitations ? (
            <Button onClick={() => setInviting(true)}>
              {t("cloud.team.invite")}
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const params = new URLSearchParams(window.location.search);
          params.set("tab", value);
          navigate(`${window.location.pathname}?${params}`, { replace: true });
        }}
      >
        <div className="mb-4 overflow-x-auto [scrollbar-width:none]">
          <TabsList variant="line">
            {tabs.map((entry) => (
              <TabsTrigger key={entry} value={entry}>
                {t(TAB_KEY[entry])}
                {entry !== "invitations" && !members.isPending ? (
                  <span className="ms-1.5 text-muted-foreground tabular-nums">
                    {entry === "members" ? staff.length : guests.length}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="members">{body(staff, false)}</TabsContent>
        <TabsContent value="guests">{body(guests, true)}</TabsContent>
        {caps.manageInvitations ? (
          <TabsContent value="invitations">
            <InvitationsTab
              space={space}
              members={all}
              onInvite={() => setInviting(true)}
            />
          </TabsContent>
        ) : null}
      </Tabs>
      {inviting ? (
        <InviteDialog space={space} onClose={() => setInviting(false)} />
      ) : null}
    </>
  );
}
