import { Loadable } from "@/loading/Loadable";
import { SkeletonList } from "@/ui/skeletons";
import { LOCAL_SOURCE_ID, currentSource, onLocal } from "../../../api/source";
import { useCanvasStore } from "../../../store/canvas-store";
import { lk } from "../local-key";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/state";
import { StatusPill } from "@/ui/status-pill";
import { toast } from "@/ui/toast";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Field } from "../../git/forms";
import {
  type ConfigurableForge,
  type ForgeConfig,
  FORGE_NAMES,
  deleteForgeConfig,
  forgeConfigs,
  forgeFailureKey,
  putForgeConfig,
} from "../../../api/forge";

export const forgeConfigKeys = {
  all: lk("forge", "configs"),
  scope: (workspaceId: string | null) =>
    lk("forge", "configs", workspaceId ?? ""),
};

const PLATFORMS: readonly ConfigurableForge[] = ["gitea", "gitlab"];

/** API 根 → 用户填的站点根：表单回填时少一段 `/api/v1`、`/api/v4`。 */
function siteRoot(apiBase: string): string {
  return apiBase.replace(/\/api\/v[14]$/, "");
}

interface Draft {
  repoKey: string;
  forge: ConfigurableForge;
  apiBase: string;
  token: string;
  /** 0 = 新建。 */
  revision: number;
}

const EMPTY: Draft = {
  repoKey: "",
  forge: "gitea",
  apiBase: "",
  token: "",
  revision: 0,
};

/**
 * 设置 → Git 托管里 GitHub 以外的平台（契约 §29.3）：按主机或按仓库选 Gitea /
 * GitLab、地址与令牌。
 *
 * 范围（契约 §75）：整台机器，或当前打开的工作空间自己的一份——它在这个工作
 * 空间里盖过整机的配置。工作空间在别的源上时只有整台机器（设置写本机）。
 *
 * 令牌只往外走一次：password 输入框，永远不回填；core 先用它核验再存，成功后
 * 立即从组件状态清掉。答复只说「有没有令牌」与它属于哪个账号。
 */
export function ForgeConfigs() {
  const t = useT();
  const client = useQueryClient();
  const workspace = useCanvasStore((state) => state.workspace);
  // 设置写本机：别的源上的工作空间在本机库里没有。
  const localWorkspace =
    workspace && currentSource().sourceId === LOCAL_SOURCE_ID
      ? workspace
      : null;
  const [scopeChoice, setScopeChoice] = React.useState<"machine" | "workspace">(
    "machine",
  );
  const scope =
    scopeChoice === "workspace" && localWorkspace ? localWorkspace.id : null;
  const configs = useQuery({
    queryKey: forgeConfigKeys.scope(scope),
    queryFn: () => onLocal(() => forgeConfigs(scope)),
    retry: false,
  });
  const [draft, setDraft] = React.useState<Draft | null>(null);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: forgeConfigKeys.all });
    void client.invalidateQueries({ queryKey: ["forge"] });
  };
  const fail = (error: unknown) => toast.error(t(forgeFailureKey(error)));

  const save = useMutation({
    mutationFn: (input: Draft & { clearToken?: boolean }) =>
      onLocal(() =>
        putForgeConfig(
          input.repoKey.trim().toLowerCase(),
          {
            forge: input.forge,
            apiBase: input.apiBase.trim(),
            ...(input.clearToken
              ? { token: "" }
              : input.token.trim()
                ? { token: input.token.trim() }
                : {}),
            expectedRevision: input.revision,
          },
          scope,
        ),
      ),
    onSuccess: () => {
      // 令牌在 core 收下的那一刻离开这个组件。
      setDraft(null);
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (config: ForgeConfig) =>
      onLocal(() => deleteForgeConfig(config.repoKey, config.revision, scope)),
    onSuccess: () => {
      refresh();
    },
    onError: fail,
  });

  const busy = save.isPending || remove.isPending;
  const rows = configs.data ?? [];

  return (
    <SettingsGroup title={t("forge.settings.others")}>
      {localWorkspace && (
        <div className="px-4 pt-3" data-slot="forge-config-scope">
          <Field label={t("forge.settings.scope")}>
            <Select
              value={scopeChoice}
              disabled={busy}
              onValueChange={(next) => {
                setDraft(null);
                setScopeChoice(next as "machine" | "workspace");
              }}
            >
              <SelectTrigger className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="machine">
                  {t("forge.settings.scopeMachine")}
                </SelectItem>
                <SelectItem value="workspace">
                  {t("forge.settings.scopeWorkspace", {
                    name: localWorkspace.name,
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <Loadable
        loading={configs.isLoading}
        skeleton={
          <SkeletonList
            rows={2}
            label={t("state.loading")}
            rowClassName="h-16 px-4"
          />
        }
      >
        {configs.isError && (
          <div
            role="status"
            className="px-4 py-3 text-meta text-destructive"
            data-slot="forge-configs-error"
          >
            {t(forgeFailureKey(configs.error))}
          </div>
        )}
        {configs.data && rows.length === 0 && draft === null && (
          <EmptyState inline title={t("forge.settings.empty")} />
        )}
        {rows.map((config) => (
          <div
            key={config.repoKey}
            data-slot="forge-config"
            data-key={config.repoKey}
            className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-3 text-meta"
          >
            <span className="min-w-0 flex-1 truncate font-mono select-text">
              {config.repoKey}
            </span>
            <Badge variant="outline" size="sm">
              {FORGE_NAMES[config.forge] ?? config.forge}
            </Badge>
            <StatusPill
              size="sm"
              tone={config.credential ? "done" : "paused"}
              label={
                config.credential
                  ? (config.accountLogin ?? t("forge.settings.credential"))
                  : t("forge.settings.noCredential")
              }
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                setDraft({
                  repoKey: config.repoKey,
                  forge: config.forge === "gitlab" ? "gitlab" : "gitea",
                  apiBase: siteRoot(config.apiBase),
                  token: "",
                  revision: config.revision,
                })
              }
            >
              {t("forge.settings.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => remove.mutate(config)}
            >
              {t("forge.settings.remove")}
            </Button>
          </div>
        ))}
      </Loadable>
      {draft ? (
        <form
          data-slot="forge-config-form"
          className="flex min-w-0 flex-col gap-3 px-4 py-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !draft.repoKey.trim() || !draft.apiBase.trim()) return;
            save.mutate(draft);
          }}
        >
          <Field label={t("forge.settings.key")}>
            <Input
              value={draft.repoKey}
              disabled={draft.revision > 0}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("forge.settings.keyPlaceholder")}
              onChange={(event) =>
                setDraft({ ...draft, repoKey: event.target.value })
              }
              className="min-w-0 font-mono"
            />
          </Field>
          <Field label={t("forge.settings.platform")}>
            <Select
              value={draft.forge}
              onValueChange={(next) =>
                setDraft({
                  ...draft,
                  forge: next as ConfigurableForge,
                })
              }
            >
              <SelectTrigger className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {FORGE_NAMES[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("forge.settings.apiBase")}>
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiBase}
              onChange={(event) =>
                setDraft({ ...draft, apiBase: event.target.value })
              }
              className="min-w-0"
            />
          </Field>
          <Field label={t("forge.settings.token")}>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-slot="forge-token"
              placeholder={
                draft.revision > 0 ? t("forge.settings.tokenKeep") : undefined
              }
              value={draft.token}
              onChange={(event) =>
                setDraft({ ...draft, token: event.target.value })
              }
              className="min-w-0"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy || !draft.repoKey.trim() || !draft.apiBase.trim()}
            >
              {t("forge.settings.save")}
            </Button>
            {draft.revision > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => save.mutate({ ...draft, clearToken: true })}
              >
                {t("forge.settings.clearToken")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {t("forge.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="px-4 py-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !configs.data}
            onClick={() => setDraft(EMPTY)}
          >
            {t("forge.settings.add")}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
}
