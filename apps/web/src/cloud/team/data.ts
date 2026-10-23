import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { spacesQuery } from "../api/queries";
import type { CloudSpace } from "../space";
import type { TeamRole } from "../shell/model";
import type { InviteRole } from "./roles";

/** 团队空间的数据层（云端控制台 §6.2 `members` / `invitations` / `settings` / `usage`）。 */
type Teams = CloudClient["teams"];
export type TeamMember = Awaited<
  ReturnType<Teams["members"]>
>["members"][number];
export type TeamInvitation = Awaited<
  ReturnType<CloudClient["invitations"]["list"]>
>["invitations"][number];
export type TeamSettings = Awaited<ReturnType<Teams["settings"]>>;
export type TeamInfo = Awaited<ReturnType<Teams["get"]>>;

export type TeamSpace = Extract<CloudSpace, { kind: "team" }>;

/** 地址里的团队 → 空间与它在 `me.spaces` 里的名字、角色、计划；还没取到或不在其中是 `undefined`。 */
export function useTeamSpace(slug: string | undefined) {
  const api = useCloudApi();
  const spaces = useQuery(spacesQuery(api));
  const found = spaces.data?.spaces.find(
    (space) => space.kind === "team" && space.slug === slug,
  );
  if (found?.kind !== "team") return { pending: spaces.isPending };
  return {
    pending: false,
    team: {
      space: {
        kind: "team",
        teamId: found.teamId,
        slug: found.slug,
      } satisfies TeamSpace as TeamSpace,
      name: found.name,
      role: found.role as TeamRole,
      plan: found.plan,
    },
  };
}

const teamId = (space: TeamSpace) => space.teamId;
const keyOf = (space: TeamSpace) => `t:${space.teamId}` as const;

export function useMembers(space: TeamSpace, enabled = true) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.members(keyOf(space)),
    enabled,
    queryFn: () => api.client.teams.members({ teamId: teamId(space) }),
  });
}

export function useTeamInvitations(space: TeamSpace, enabled = true) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.invitations(keyOf(space)),
    enabled,
    queryFn: () =>
      api.client.invitations.list({ box: "sent", teamId: teamId(space) }),
  });
}

export function useTeamSettings(space: TeamSpace, enabled = true) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.settings(keyOf(space)),
    enabled,
    queryFn: () => api.client.teams.settings({ teamId: teamId(space) }),
  });
}

/** 团队用量（主机 / 成员 / 访客 / 本月流量，对照计划上限）；与 `billing.usage` 的键分开，形状不同。 */
export function useTeamUsage(space: TeamSpace, enabled = true) {
  const api = useCloudApi();
  return useQuery({
    queryKey: [...cloudKeys.usage(keyOf(space)), "team"] as const,
    enabled,
    queryFn: () => api.client.teams.usage({ teamId: teamId(space) }),
  });
}

/** 所有者名下处于恢复期的团队（`me.spaces` 不列它们）。 */
export function useDeletedTeams(enabled: boolean) {
  const api = useCloudApi();
  return useQuery({
    queryKey: ["cloud", "teams", "deleted"] as const,
    enabled,
    queryFn: async () => {
      const { teams } = await api.client.teams.list({});
      return teams.filter((team) => team.deletedAtMs !== null);
    },
  });
}

/** 成员或空间变了：成员、邀请、空间列表（角色、名字、有没有这个团队）都重拉。 */
function refreshMembers(client: QueryClient, space: TeamSpace) {
  return Promise.all([
    client.invalidateQueries({ queryKey: cloudKeys.members(keyOf(space)) }),
    client.invalidateQueries({ queryKey: cloudKeys.invitations(keyOf(space)) }),
    client.invalidateQueries({ queryKey: cloudKeys.spaces }),
  ]);
}

export function useCreateTeam() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: string; name: string }) =>
      api.client.teams.create(input),
    // 先等空间列表更新，调用方再跳进新团队，免得落在「找不到」上。
    onSuccess: () => client.invalidateQueries({ queryKey: cloudKeys.spaces }),
  });
}

export function useInvite(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: InviteRole }) =>
      api.client.invitations.create({
        kind: "team",
        teamId: teamId(space),
        ...input,
      }),
    onSettled: () =>
      client.invalidateQueries({
        queryKey: cloudKeys.invitations(keyOf(space)),
      }),
  });
}

export function useResendInvitation(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.client.invitations.resend({ invitationId }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: cloudKeys.invitations(keyOf(space)),
      }),
  });
}

export function useRevokeInvitation(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      api.client.invitations.revoke({ invitationId }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: cloudKeys.invitations(keyOf(space)),
      }),
  });
}

export function useChangeRole(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      accountId: string;
      role: Exclude<TeamRole, "owner">;
    }) => api.client.teams.memberRole({ teamId: teamId(space), ...input }),
    onSuccess: () => refreshMembers(client, space),
  });
}

export function useRemoveMember(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      api.client.teams.memberRemove({ teamId: teamId(space), accountId }),
    onSuccess: () => refreshMembers(client, space),
  });
}

/** 离开后调用方马上回个人空间；空间列表在后台重拉，不等它（免得先闪一下「找不到」）。 */
export function useLeaveTeam(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.client.teams.leave({ teamId: teamId(space) }),
    onSuccess: () => {
      void refreshMembers(client, space);
    },
  });
}

export function useTransferOwnership(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      api.client.teams.transferOwnership({ teamId: teamId(space), accountId }),
    onSuccess: () => refreshMembers(client, space),
  });
}

/**
 * 改动即存：先改缓存让开关立刻动，结束后（成败都）重拉以服务端为准——连点几项时不手工恢复快照，
 * 免得把另一项在途的修改一并盖回去。失败的提示归调用方（sonner）。
 */
export function useUpdateSettings(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  const key = cloudKeys.settings(keyOf(space));
  return useMutation({
    mutationFn: (patch: Partial<TeamSettings>) =>
      api.client.teams.settingsUpdate({ teamId: teamId(space), ...patch }),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<TeamSettings>(key, (previous) =>
        previous ? { ...previous, ...patch } : previous,
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

export function useRenameTeam(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.client.teams.update({ teamId: teamId(space), name }),
    onSuccess: () => client.invalidateQueries({ queryKey: cloudKeys.spaces }),
  });
}

export function useDeleteTeam(space: TeamSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.client.teams.delete({ teamId: teamId(space) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: cloudKeys.spaces });
      await client.invalidateQueries({
        queryKey: ["cloud", "teams", "deleted"],
      });
    },
  });
}

export function useRestoreTeam() {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.client.teams.restore({ teamId: id }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: cloudKeys.spaces });
      await client.invalidateQueries({
        queryKey: ["cloud", "teams", "deleted"],
      });
    },
  });
}
