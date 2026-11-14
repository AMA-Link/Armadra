import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GithubCredentialSource, GithubSecretStore } from "../../../api/github";

import { Loadable } from "@/loading/Loadable";
import { Skeleton } from "@/ui/skeleton";
import { SkeletonForm } from "@/ui/skeletons";
import { Alert, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { EmptyState } from "@/ui/state";
import { StatusPill } from "@/ui/status-pill";
import { toast } from "@/ui/toast";
import { useT } from "../../../app/preferences-store";
import { useGithubSession } from "../../../host/github-session";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsPageHeader } from "../SettingsPageHeader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Field } from "../../git/forms";
import { failureKey } from "../../github/model";
import { githubKeys } from "../../github/queries";
import {
  EMPTY_DRAFT,
  ForgeConfigs,
  forgeHostsKey,
  type Draft,
} from "./ForgeConfigs";
import { onLocal } from "../../../api/source";
import {
  FORGE_NAMES,
  type ForgeHosts,
  forgeFailureKey,
  forgeHosts,
  setReuseLocalLogins,
} from "../../../api/forge";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Switch } from "@/ui/switch";
import { SettingsRow } from "../SettingsRow";

/**
 * 设置 → 代码托管（契约 §5、§29.3）：「复用本机登录」开关、「已识别」的主机表
 * （主机 / 平台 / 令牌来源 / 账号，缺令牌的行可「配置」），最后是折叠的「手动配置」：
 * GitHub 的凭据，以及按主机 / 仓库配置的 Gitea 与 GitLab（{@link ForgeConfigs}）。
 *
 * 令牌只往外走一次：输入框是 password 类型，永远不回填、不从任何回应里读回来，
 * 保存成功后立即从组件状态里清掉。降级到 0600 文件时徽标明说。
 */
export function ForgePage() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const state = useGithubSession((store) => store.state);
  const client = useGithubSession((store) => store.client);
  const connect = useGithubSession((store) => store.connect);
  const queryClient = useQueryClient();

  const workspaceId = workspace?.id ?? null;
  const [source, setSource] = React.useState<GithubCredentialSource>(
    GithubCredentialSource.GH_CLI,
  );
  const [apiBase, setApiBase] = React.useState("");
  const [token, setToken] = React.useState("");

  React.useEffect(() => {
    void connect(workspaceId);
  }, [connect, workspaceId]);

  const credential = useQuery({
    queryKey: githubKeys.credential(workspaceId ?? ""),
    queryFn: () => client!.getCredential(),
    enabled: Boolean(client),
    retry: false,
  });
  const status = credential.data;
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const configure = useMutation({
    mutationFn: () =>
      client!.configureCredential({
        source,
        token: source === GithubCredentialSource.TOKEN_REF ? token : undefined,
        apiBase: apiBase.trim() || undefined,
        expectedRevision: status?.revision ?? 0n,
      }),
    onSuccess: () => {
      // The token leaves this component the moment the Host accepted it.
      setToken("");
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
      void connect(workspaceId);
    },
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: () =>
      client!.revokeCredential({ expectedRevision: status!.revision }),
    onSuccess: () => {
      setToken("");
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
      void connect(workspaceId);
    },
    onError: fail,
  });

  const hosts = useQuery({
    queryKey: forgeHostsKey,
    queryFn: () => onLocal(() => forgeHosts()),
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      onLocal(() => setReuseLocalLogins(enabled)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: forgeHostsKey });
      void queryClient.invalidateQueries({ queryKey: ["forge"] });
    },
    onError: (error) => toast.error(t(forgeFailureKey(error))),
  });
  // 旧 core 没有主机表：手动配置直接展开，页面退回原来的样子。
  const [manualOpen, setManualOpen] = React.useState<boolean | null>(null);
  const [prefill, setPrefill] = React.useState<{
    nonce: number;
    draft: Draft;
  } | null>(null);
  const configureHost = (row: ForgeHosts["hosts"][number]) => {
    if (row.forge !== "github")
      setPrefill((previous) => ({
        nonce: (previous?.nonce ?? 0) + 1,
        draft: {
          ...EMPTY_DRAFT,
          repoKey: row.host,
          forge: row.forge === "gitlab" ? "gitlab" : "gitea",
        },
      }));
    setManualOpen(true);
  };

  const blocked =
    state.status === "blocked" && state.reason !== "noCredential"
      ? state.reason
      : null;
  const busy = configure.isPending || revoke.isPending;

  return (
    <>
      <SettingsPageHeader />
      {hosts.data && (
        <DetectedHosts
          hosts={hosts.data}
          busy={toggle.isPending}
          onToggle={(enabled) => toggle.mutate(enabled)}
          onConfigure={configureHost}
        />
      )}
      <Collapsible
        open={manualOpen ?? hosts.isError}
        onOpenChange={setManualOpen}
        data-slot="forge-manual"
        className="flex flex-col gap-(--space-group)"
      >
        <CollapsibleTrigger className="group/manual flex w-fit items-center gap-1 px-0.5 text-body font-medium text-foreground">
          <ChevronRight
            aria-hidden
            className="size-4 transition-transform group-data-[state=open]/manual:rotate-90"
          />
          {t("forge.manual")}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-(--space-block)">
          {blocked ? (
            <Alert role="status">
              <AlertTitle>{t(`github.blocked.${blocked}`)}</AlertTitle>
            </Alert>
          ) : (
            <Loadable
              loading={!client}
              skeleton={
                <SettingsGroup title={FORGE_NAMES.github}>
                  <div className="px-4 py-3">
                    <SkeletonForm rows={2} label={t("state.loading")} />
                  </div>
                </SettingsGroup>
              }
            >
              <SettingsGroup title={FORGE_NAMES.github}>
                <Loadable
                  loading={credential.isLoading}
                  skeleton={
                    <div className="px-4 pt-3">
                      <Skeleton className="h-5 w-40" />
                    </div>
                  }
                >
                  {status && (
                    <div
                      data-slot="github-status"
                      className="flex min-w-0 flex-wrap items-center gap-2 px-4 pt-3 text-meta"
                    >
                      <StatusPill
                        size="sm"
                        tone={status.available ? "done" : "paused"}
                        label={t(
                          status.available
                            ? "github.settings.available"
                            : "github.settings.unavailable",
                        )}
                      />
                      {status.accountLogin && (
                        <Badge variant="outline" size="sm" className="truncate">
                          {status.accountLogin}
                        </Badge>
                      )}
                      {status.enterprise && (
                        <Badge variant="outline" size="sm">
                          {t("github.enterprise")}
                        </Badge>
                      )}
                      {status.store === GithubSecretStore.FILE_FALLBACK && (
                        <Badge variant="outline" size="sm">
                          {t("github.store.fileFallback")}
                        </Badge>
                      )}
                    </div>
                  )}
                </Loadable>
                <form
                  className="flex min-w-0 flex-col gap-3 px-4 py-3"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy) return;
                    if (
                      source === GithubCredentialSource.TOKEN_REF &&
                      !token.trim()
                    )
                      return;
                    configure.mutate();
                  }}
                >
                  <Field label={t("github.settings.source")}>
                    <Select
                      value={String(source)}
                      onValueChange={(next) =>
                        // 枚举在线上是名字，下拉框的值就是那个名字。
                        setSource(next as GithubCredentialSource)
                      }
                    >
                      <SelectTrigger className="w-full min-w-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={String(GithubCredentialSource.NONE)}>
                          {t("github.source.none")}
                        </SelectItem>
                        <SelectItem
                          value={String(GithubCredentialSource.GH_CLI)}
                        >
                          {t("github.source.ghCli")}
                        </SelectItem>
                        <SelectItem
                          value={String(GithubCredentialSource.TOKEN_REF)}
                        >
                          {t("github.source.token")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t("github.settings.apiBase")}>
                    <Input
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiBase}
                      onChange={(event) => setApiBase(event.target.value)}
                      className="min-w-0"
                    />
                  </Field>
                  {source === GithubCredentialSource.TOKEN_REF && (
                    <Field label={t("github.settings.token")}>
                      <Input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        data-slot="github-token"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        className="min-w-0"
                      />
                    </Field>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        (source === GithubCredentialSource.TOKEN_REF &&
                          !token.trim())
                      }
                    >
                      {t("github.settings.save")}
                    </Button>
                    {status && status.revision > 0n && (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => revoke.mutate()}
                      >
                        {t("github.settings.revoke")}
                      </Button>
                    )}
                  </div>
                </form>
              </SettingsGroup>

              <ForgeConfigs prefill={prefill} />
            </Loadable>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** 「复用本机登录」开关与已识别的主机表：缺令牌的行带「配置」。 */
function DetectedHosts({
  hosts,
  busy,
  onToggle,
  onConfigure,
}: {
  hosts: ForgeHosts;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onConfigure: (row: ForgeHosts["hosts"][number]) => void;
}) {
  const t = useT();
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("forge.reuseLogins")}>
          <Switch
            checked={hosts.reuseLocalLogins}
            disabled={busy}
            aria-label={t("forge.reuseLogins")}
            onCheckedChange={onToggle}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("forge.detected")}>
        {hosts.hosts.length === 0 && (
          <EmptyState inline title={t("forge.hosts.empty")} />
        )}
        {hosts.hosts.map((row) => (
          <div
            key={row.host}
            data-slot="forge-host"
            data-host={row.host}
            className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-3 text-meta"
          >
            <span className="min-w-0 flex-1 truncate font-mono select-text">
              {row.host}
            </span>
            {row.forge && (
              <Badge variant="outline" size="sm">
                {FORGE_NAMES[row.forge] ?? row.forge}
              </Badge>
            )}
            {row.credential ? (
              <>
                {row.credentialSource && (
                  <span className="text-muted-foreground">
                    {t(`forge.source.${row.credentialSource}`)}
                  </span>
                )}
                {row.accountLogin && (
                  <Badge variant="secondary" size="sm" className="truncate">
                    {row.accountLogin}
                  </Badge>
                )}
              </>
            ) : (
              <>
                <StatusPill
                  size="sm"
                  tone="paused"
                  label={t("forge.settings.noCredential")}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onConfigure(row)}
                >
                  {t("forge.hosts.configure")}
                </Button>
              </>
            )}
          </div>
        ))}
      </SettingsGroup>
    </>
  );
}
