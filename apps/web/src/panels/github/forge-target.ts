import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { ForgeRepoRef } from "@armadra/shared";

import { useGithubSession } from "@/host/github-session";
import { sk } from "../../sources/scope";
import {
  type ForgeDetection,
  detectForge,
  forgeFailureKey,
  forgeWorkspaceRepository,
} from "../../api/forge";

/**
 * 画布节点用的「这个仓库是哪个」：节点记着仓库就按它认，没有就按工作空间的
 * 仓库（选中的 remote）自动识别。面板（`GithubDrawer`）有自己的一套带 remote
 * 切换与手填地址的流程；节点不做那些，只回答现在能不能显示、不能的话为什么。
 */
export type ForgeTarget =
  | { status: "connecting" }
  | { status: "blocked"; reason: string }
  | { status: "noRepo"; reason: string }
  | { status: "unknown" }
  | { status: "noLogin"; detection: ForgeDetection }
  | { status: "error"; messageKey: string }
  | { status: "ready"; detection: ForgeDetection };

export function useForgeTarget(
  repo: ForgeRepoRef | null,
  workspaceId: string | null,
): ForgeTarget {
  const state = useGithubSession((store) => store.state);
  const client = useGithubSession((store) => store.client);
  const connect = useGithubSession((store) => store.connect);
  React.useEffect(() => {
    void connect(workspaceId);
  }, [connect, workspaceId]);

  const blocked =
    state.status === "blocked" && state.reason !== "noCredential"
      ? state.reason
      : null;
  const live = Boolean(client) && blocked === null;

  const workspaceRepository = useQuery({
    queryKey: sk("forge", "workspace-repository", workspaceId ?? ""),
    queryFn: () => forgeWorkspaceRepository(workspaceId!),
    enabled: live && repo === null && workspaceId !== null,
    retry: false,
  });
  const remotes = workspaceRepository.data;
  const auto =
    remotes?.remotes.find((remote) => remote.name === remotes.selected)
      ?.detection ?? null;

  const detected = useQuery({
    queryKey: sk(
      "forge",
      "detect-repo",
      workspaceId ?? "",
      repo?.host ?? "",
      repo?.owner ?? "",
      repo?.name ?? "",
    ),
    queryFn: () => detectForge(repo!, workspaceId),
    enabled: live && repo !== null,
    retry: false,
  });

  if (blocked) return { status: "blocked", reason: blocked };
  if (!live) return { status: "connecting" };
  const query = repo === null ? workspaceRepository : detected;
  if (query.isError)
    return { status: "error", messageKey: forgeFailureKey(query.error) };
  if (query.isLoading) return { status: "connecting" };
  if (repo === null) {
    if (remotes && remotes.reason !== "ok")
      return { status: "noRepo", reason: remotes.reason };
    if (!auto) return { status: "noRepo", reason: "noRemote" };
  }
  const detection = repo === null ? auto : (detected.data ?? null);
  if (!detection) return { status: "connecting" };
  if (detection.forge === null) return { status: "unknown" };
  if (!detection.credential) return { status: "noLogin", detection };
  return { status: "ready", detection };
}
