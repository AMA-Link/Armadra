import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { WorkPanelSheet } from "../WorkPanelSheet";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useGithubSession } from "@/host/github-session";
import { useCanvasStore } from "@/store/canvas-store";
import { sk } from "../../sources/scope";
import { ForgeHosted, OpenRemote } from "./ForgeHosted";
import { RepositoryPicker } from "./RepositoryPicker";
import { useGithubFocus } from "./open";
import {
  FORGE_NAMES,
  type ForgeRepo,
  detectForge,
  forgeFailureKey,
  resolveForge,
} from "../../api/forge";

/**
 * 右侧工作面板的「代码托管」页（契约 §29）：GitHub、Gitea、GitLab 同一面，
 * 只读——仓库信息、issue 与 PR 的列表和详情（{@link ForgeHosted}）。
 *
 * 远端地址经 `forge.resolve` 认平台与凭据；认不出或没有令牌时停在那里并指去
 * 设置。Host 没连上、没配对时整页只显示原因和去设置的入口。
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
      resolveRepo ? detectForge(resolveRepo) : resolveForge(resolveUrl),
    enabled:
      open &&
      Boolean(sessionClient) &&
      (resolveRepo !== null || resolveUrl.length > 0),
    retry: false,
  });
  const found = detection.data;
  const ready = found && found.forge !== null && found.credential;

  const toSettings = (section: "forge" | "service" | "devices") => {
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
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
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
        <div
          role="status"
          className="min-w-0 space-y-3 p-4 text-[13px] leading-5"
        >
          <p className="text-muted-foreground">
            {t(`github.blocked.${blocked}`)}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="min-h-10"
            onClick={() =>
              toSettings(
                blocked === "signedOut" ||
                  blocked === "noPermission" ||
                  blocked === "nativeSession"
                  ? "devices"
                  : "service",
              )
            }
          >
            {t("github.blocked.action")}
          </Button>
        </div>
      ) : !sessionClient ? (
        <p role="status" className="p-4 text-[13px] text-muted-foreground">
          {t("github.loading")}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <RepositoryPicker
            remoteUrl={remoteUrl}
            onRemoteUrl={setRemoteUrl}
            onResolve={() => {
              setResolveRepo(null);
              setResolveUrl(remoteUrl.trim());
            }}
            busy={detection.isFetching}
          />
          {detection.isError && (
            <p role="status" className="px-3 py-2 text-[12px] text-destructive">
              {t(forgeFailureKey(detection.error))}
            </p>
          )}
          {found && !ready && (
            <div
              role="status"
              data-slot="forge-unconfigured"
              className="min-w-0 space-y-3 p-3 text-[13px] leading-5"
            >
              <p className="text-muted-foreground">
                {t(
                  found.forge === null ? "forge.unknown" : "forge.noCredential",
                )}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="min-h-10"
                onClick={() => toSettings("forge")}
              >
                {t("forge.configure")}
              </Button>
            </div>
          )}
          {found && ready && (
            <>
              <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-[12px]">
                <span
                  data-slot="forge-repository"
                  // GitLab 多级子组的路径可能很长：截断时悬停看全。
                  title={`${found.repository.owner}/${found.repository.name}`}
                  className="min-w-0 truncate font-medium select-text"
                >
                  {found.repository.owner}/{found.repository.name}
                </span>
                <Badge variant="outline">
                  {FORGE_NAMES[found.forge ?? ""] ?? found.forge}
                </Badge>
                {found.accountLogin && (
                  <Badge variant="secondary" className="truncate">
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
