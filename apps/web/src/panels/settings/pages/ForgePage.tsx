import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GithubCredentialSource, GithubSecretStore } from "../../../api/github";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "../../../app/preferences-store";
import { useGithubSession } from "../../../host/github-session";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
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
import { ForgeConfigs } from "./ForgeConfigs";
import { FORGE_NAMES } from "../../../api/forge";

/**
 * 设置 → 代码托管（契约 §5、§29.3）：上面是 GitHub 的凭据与一行状态徽标，
 * 下面是按主机 / 仓库配置的 Gitea 与 GitLab（{@link ForgeConfigs}）。
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
      toast.success(t("github.settings.saved"));
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
      toast.success(t("github.settings.revoked"));
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
      void connect(workspaceId);
    },
    onError: fail,
  });

  const blocked =
    state.status === "blocked" && state.reason !== "noCredential"
      ? state.reason
      : null;
  const busy = configure.isPending || revoke.isPending;

  return (
    <>
      {blocked || !client ? (
        <p
          role="status"
          className="text-[13px] leading-5 text-muted-foreground"
        >
          {blocked ? t(`github.blocked.${blocked}`) : t("github.loading")}
        </p>
      ) : (
        <>
          <SettingsGroup title={FORGE_NAMES.github}>
            {status && (
              <div
                data-slot="github-status"
                className="flex min-w-0 flex-wrap items-center gap-2 px-4 pt-3 text-[12px]"
              >
                <Badge variant={status.available ? "secondary" : "outline"}>
                  {t(
                    status.available
                      ? "github.settings.available"
                      : "github.settings.unavailable",
                  )}
                </Badge>
                {status.accountLogin && (
                  <Badge variant="outline" className="truncate">
                    {status.accountLogin}
                  </Badge>
                )}
                {status.enterprise && (
                  <Badge variant="outline">{t("github.enterprise")}</Badge>
                )}
                {status.store === GithubSecretStore.FILE_FALLBACK && (
                  <Badge variant="outline">
                    {t("github.store.fileFallback")}
                  </Badge>
                )}
              </div>
            )}
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
                  <SelectTrigger className="h-9 w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[var(--z-dialog)]">
                    <SelectItem value={String(GithubCredentialSource.NONE)}>
                      {t("github.source.none")}
                    </SelectItem>
                    <SelectItem value={String(GithubCredentialSource.GH_CLI)}>
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
                  className="h-10 min-w-0"
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
                    className="h-10 min-w-0"
                  />
                </Field>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-10"
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
                    size="sm"
                    variant="destructive"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() => revoke.mutate()}
                  >
                    {t("github.settings.revoke")}
                  </Button>
                )}
              </div>
            </form>
          </SettingsGroup>

          <ForgeConfigs />
        </>
      )}
    </>
  );
}
