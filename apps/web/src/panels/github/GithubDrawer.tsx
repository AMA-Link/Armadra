import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RotateCw, X } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { IconButton } from "@/ui/icon-button";
import { Loadable } from "@/loading/Loadable";
import { ScrollArea } from "@/ui/scroll-area";
import { Skeleton } from "@/ui/skeleton";
import { EmptyState } from "@/ui/state";
import { SheetTitle } from "@/ui/sheet";
import { WorkPanelSheet } from "../WorkPanelSheet";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useGithubSession } from "@/host/github-session";
import { useCanvasStore } from "@/store/canvas-store";
import { sk } from "../../sources/scope";
import { ForgeHosted, ForgeListSkeleton, OpenRemote } from "./ForgeHosted";
import { MANUAL_REMOTE, RemoteSwitcher } from "./RemoteSwitcher";
import { RepositoryPicker } from "./RepositoryPicker";
import { EMPTY_DRAFT, ForgeConfigForm } from "../settings/pages/ForgeConfigs";
import { useGithubFocus } from "./open";
import {
  FORGE_NAMES,
  type ForgeDetection,
  type ForgeRepo,
  detectForge,
  forgeFailureKey,
  forgeWorkspaceRepository,
  resolveForge,
  selectWorkspaceRemote,
} from "../../api/forge";

/**
 * 右侧工作面板的「代码托管」页（契约 §29）：GitHub、Gitea、GitLab 同一面，
 * 只读——仓库信息、issue 与 PR 的列表和详情（{@link ForgeHosted}）。
 *
 * 打开即由 `forge.workspaceRepository` 认出工作空间的仓库（各 remote 在顶部下拉
 * 里切换）；认不出时回到手填远端地址，经 `forge.resolve` 认平台与凭据。没有登录时
 * 显示「没找到登录」与重试，手动配置折叠在下面。Host 没连上、没配对时整页只显示
 * 原因和去设置的入口。
 */
export function GithubDrawer() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const mode = useCanvasStore((state) => state.panels.github);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const state = useGithubSession((store) => store.state);
  const sessionClient = useGithubSession((store) => store.client);
  const connect = useGithubSession((store) => store.connect);
  const focusTab = useGithubFocus((store) => store.tab);
  const focusNumber = useGithubFocus((store) => store.number);
  const reveal = useGithubFocus((store) => store.reveal);
  const focusTarget = useGithubFocus((store) => store.target);
  const queryClient = useQueryClient();

  const open = mode === "drawer";
  const workspaceId = workspace?.id ?? null;
  const [remoteUrl, setRemoteUrl] = React.useState("");
  const [resolveUrl, setResolveUrl] = React.useState("");
  // 连接徽标点进来的条目：按它记着的仓库认，不靠手填的地址。
  const [resolveRepo, setResolveRepo] = React.useState<ForgeRepo | null>(null);

  React.useEffect(() => {
    if (open) void connect(workspaceId);
  }, [connect, open, workspaceId]);
  React.useEffect(() => {
    if (!open || reveal === 0 || focusTarget === null) return;
    setResolveRepo({
      host: focusTarget.host,
      owner: focusTarget.owner,
      name: focusTarget.name,
    });
  }, [focusTarget, open, reveal]);

  // 拿不到 GitHub 凭据不挡整页：识别结果会说这个仓库有没有令牌。
  const blocked =
    state.status === "blocked" && state.reason !== "noCredential"
      ? state.reason
      : null;

  // 打开即识别工作空间的仓库；选 remote、手填地址是它的两个出口。
  const [manual, setManual] = React.useState(false);
  const wsKey = sk("forge", "workspace-repository", workspaceId ?? "");
  const workspaceRepository = useQuery({
    queryKey: wsKey,
    queryFn: () => forgeWorkspaceRepository(workspaceId!),
    enabled: open && Boolean(sessionClient) && workspaceId !== null,
    retry: false,
  });
  const repositories = workspaceRepository.data;
  const selectRemote = useMutation({
    mutationFn: (remote: string) => selectWorkspaceRemote(workspaceId!, remote),
    onSuccess: (next) => queryClient.setQueryData(wsKey, next),
  });
  const onSwitch = (value: string) => {
    setResolveRepo(null);
    if (value === MANUAL_REMOTE) {
      setManual(true);
      return;
    }
    setManual(false);
    selectRemote.mutate(value);
  };
  const autoRemote =
    repositories?.remotes.find(
      (remote) => remote.name === repositories.selected,
    ) ?? null;
  // 自动识别出了 remote 就不再要手填的那一栏。
  const auto = !manual && resolveRepo === null && autoRemote !== null;

  const detection = useQuery({
    queryKey: resolveRepo
      ? sk(
          "forge",
          "detect-repo",
          workspaceId ?? "",
          resolveRepo.host,
          resolveRepo.owner,
          resolveRepo.name,
        )
      : sk("forge", "detect", workspaceId ?? "", resolveUrl),
    queryFn: () =>
      resolveRepo
        ? detectForge(resolveRepo, workspaceId)
        : resolveForge(resolveUrl, workspaceId),
    enabled:
      open &&
      Boolean(sessionClient) &&
      !auto &&
      (resolveRepo !== null || resolveUrl.length > 0),
    retry: false,
  });
  const found: ForgeDetection | undefined = auto
    ? (autoRemote?.detection ?? undefined)
    : detection.data;
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ["forge"] });
    void queryClient.invalidateQueries({ queryKey: sk("forge") });
  };
  const ready = found && found.forge !== null && found.credential;

  const toSettings = (section: "forge" | "service" | "security") => {
    setPanel("github", "closed");
    usePreferencesStore.getState().setLastSettingsSection(section);
    setPanel("settings", true);
  };

  /** 徽标点进来的那一条，仓库对得上才定位过去。 */
  const focusFor = (repository: ForgeRepo) =>
    focusTarget !== null &&
    focusNumber !== null &&
    reveal > 0 &&
    focusTarget.host.toLowerCase() === repository.host.toLowerCase() &&
    focusTarget.owner.toLowerCase() === repository.owner.toLowerCase() &&
    focusTarget.name.toLowerCase() === repository.name.toLowerCase()
      ? { tab: focusTab, number: Number(focusNumber), reveal }
      : null;

  return (
    <WorkPanelSheet
      panel="github"
      open={open}
      onClose={() => setPanel("github", "closed")}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
        <SheetTitle className="shrink-0 truncate text-body font-semibold">
          {t("forge.title")}
        </SheetTitle>
        <div className="flex-1" />
        {sessionClient && (
          <IconButton
            label={t("github.reload")}
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: ["forge"] })
            }
          >
            <RotateCw />
          </IconButton>
        )}
        <IconButton
          label={t("github.close")}
          onClick={() => setPanel("github", "closed")}
        >
          <X />
        </IconButton>
      </div>

      {blocked ? (
        <EmptyState
          title={t(`github.blocked.${blocked}`)}
          className="min-w-0 p-4"
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              toSettings(
                blocked === "signedOut" ||
                  blocked === "noPermission" ||
                  blocked === "nativeSession"
                  ? "security"
                  : "service",
              )
            }
          >
            {t("github.blocked.action")}
          </Button>
        </EmptyState>
      ) : !sessionClient ? (
        <Loadable
          loading
          skeleton={<GithubSkeleton label={t("state.loading")} />}
        >
          {null}
        </Loadable>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {repositories && repositories.remotes.length > 0 && (
            <RemoteSwitcher
              repository={repositories}
              value={
                manual
                  ? MANUAL_REMOTE
                  : (repositories.selected ?? MANUAL_REMOTE)
              }
              onChange={onSwitch}
            />
          )}
          {repositories && repositories.reason !== "ok" && (
            <p
              role="status"
              data-slot="forge-reason"
              className="px-3 pt-2 text-meta text-muted-foreground"
            >
              {t(`forge.reason.${repositories.reason}`)}
            </p>
          )}
          {!auto && !workspaceRepository.isLoading && (
            <RepositoryPicker
              remoteUrl={remoteUrl}
              onRemoteUrl={setRemoteUrl}
              onResolve={() => {
                setResolveRepo(null);
                setResolveUrl(remoteUrl.trim());
              }}
              busy={detection.isFetching}
            />
          )}
          {detection.isError && (
            <p role="status" className="px-3 py-2 text-meta text-destructive">
              {t(forgeFailureKey(detection.error))}
            </p>
          )}
          {detection.isLoading && (
            <Loadable
              loading
              skeleton={<GithubSkeleton label={t("state.loading")} />}
            >
              {null}
            </Loadable>
          )}
          {found && found.forge === null && (
            <EmptyState
              title={t("forge.unknown")}
              className="m-(--space-page) w-auto"
            >
              <Button
                size="sm"
                variant="secondary"
                onClick={() => toSettings("forge")}
              >
                {t("forge.configure")}
              </Button>
            </EmptyState>
          )}
          {found && found.forge !== null && !found.credential && (
            <NoLogin
              detection={found}
              onRetry={retry}
              onSettings={() => toSettings("forge")}
            />
          )}
          {found && ready && (
            <>
              <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-meta">
                <span
                  data-slot="forge-repository"
                  // GitLab 多级子组的路径可能很长：截断时悬停看全。
                  title={`${found.repository.owner}/${found.repository.name}`}
                  className="min-w-0 truncate font-medium select-text"
                >
                  {found.repository.owner}/{found.repository.name}
                </span>
                <Badge variant="outline" size="sm">
                  {FORGE_NAMES[found.forge ?? ""] ?? found.forge}
                </Badge>
                {found.accountLogin && (
                  <Badge variant="secondary" size="sm" className="truncate">
                    {found.accountLogin}
                  </Badge>
                )}
                <div className="flex-1" />
                <OpenRemote url={found.webUrl ?? ""} />
              </div>
              <ForgeHosted
                // 同一主机下的不同仓库（含多级子组）各自一份状态。
                key={`${found.repository.host}/${found.repository.owner}/${found.repository.name}`}
                detection={found}
                locale={locale}
                workspaceId={workspaceId}
                open={open}
                focus={focusFor(found.repository)}
              />
            </>
          )}
        </ScrollArea>
      )}
    </WorkPanelSheet>
  );
}

/** 仓库头条（同真实头条的边框与内边距）加一串 issue / PR 行。 */
function GithubSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
      <ForgeListSkeleton label={label} />
    </div>
  );
}

/** 平台认出来了、没找到登录：重试，下面折叠「手动配置」（平台与地址预填，只差令牌）。 */
function NoLogin({
  detection,
  onRetry,
  onSettings,
}: {
  detection: ForgeDetection;
  onRetry: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  const host = detection.repository.host;
  const forge = detection.forge === "gitlab" ? "gitlab" : "gitea";
  let site = `https://${host}`;
  try {
    if (detection.webUrl) site = new URL(detection.webUrl).origin;
  } catch {
    // 地址写坏了就用主机名。
  }
  return (
    <div
      data-slot="forge-no-login"
      className="flex min-w-0 flex-col gap-(--space-block) p-(--space-page)"
    >
      <EmptyState title={t("forge.noLogin", { host })} className="w-auto">
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t("forge.retry")}
        </Button>
      </EmptyState>
      <Collapsible className="flex flex-col gap-(--space-group)">
        <CollapsibleTrigger className="group/manual flex w-fit items-center gap-1 text-body font-medium text-foreground">
          <ChevronRight
            aria-hidden
            className="size-4 transition-transform group-data-[state=open]/manual:rotate-90"
          />
          {t("forge.manual")}
        </CollapsibleTrigger>
        <CollapsibleContent className="rounded-card border border-border">
          {detection.forge === "github" ? (
            <div className="p-3">
              <Button size="sm" variant="secondary" onClick={onSettings}>
                {t("forge.configure")}
              </Button>
            </div>
          ) : (
            <ForgeConfigForm
              initial={{
                ...EMPTY_DRAFT,
                repoKey: host,
                forge,
                apiBase: site,
              }}
              scope={null}
              onSaved={onRetry}
            />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
