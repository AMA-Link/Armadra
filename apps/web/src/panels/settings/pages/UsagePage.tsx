import { lk } from "../local-key";
import { useQueryClient } from "@tanstack/react-query";
import { useUsage } from "../../../app/use-usage";
import type { UsageProvider, UsageProviderId } from "@armadra/shared";

import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsLoadable } from "../SettingsLoadable";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { UsageKpis, visibleUsageProviders } from "./UsageKpis";
import { Button } from "@/ui/button";
import { StatusPill } from "@/ui/status-pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** 逐个 provider 的开关顺序，和画布里的卡片顺序一致。 */
const PROVIDERS: UsageProviderId[] = ["claude", "codex", "copilot"];

/**
 * 出站政策（外部服务 §9.3）：这两家的额度要借用登录令牌，另有一个默认关的
 * 设置键。页面上仍是一个开关——开 = 两个键都开，关 = 两个键都关。
 */
const POLICY_KEYS: Partial<
  Record<UsageProviderId, "claudeUsage" | "copilotUsage">
> = { claude: "claudeUsage", copilot: "copilotUsage" };

/**
 * 刷新节奏（§4.2）。`0` = 只手动刷新；其余是后台自动刷新的分钟数。
 * Runtime 的 `normalize` 只接受这几个值，改动要两边一起改。
 */
const REFRESH_CHOICES = [0, 1, 2, 5, 15] as const;

/**
 * 设置 → 用量与额度（§24.1 + §4.2；Copilot 登录在「凭据与密钥」）。
 *
 * 页头两个动作：刷新（`POST /api/usage/refresh`，Runtime 侧 30s 内只真取一次）与打开用量
 * 面板；每个 provider 一张 KPI 托盘（各窗口的最高占用与重置倒计时，凭据永不显示）。
 *
 * §4.2 补上四组控制：总开关、逐个 provider 开关、刷新节奏、以及本地成本
 * 统计开关。
 */
export function UsagePage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { usage, refresh, refreshing, refreshFailed, now, cooldown } =
    useUsage();
  const { settings, save } = useRuntimeSettings({ scope: "local" });
  // Runtime 侧默认开（settings.rs 归一化时补 `true`）。
  const usageEnabled = settings.data?.usage?.enabled !== false;
  const costEnabled = settings.data?.usage?.cost?.enabled !== false;
  // 缺省开（G5-25）；估算来自成本扫描，扫描关着时这一项没有意义。
  const claudeLocalWindow = settings.data?.usage?.claudeLocalWindow !== false;
  const cliFallback = settings.data?.usage?.codexCliFallback === true;
  const statusBadges =
    (settings.data?.usage?.statusBadges ?? settings.data?.usage?.statusPage) !==
    false;
  const catalogAutoRefresh =
    settings.data?.models?.catalog?.autoRefresh !== false;
  const refreshMinutes = settings.data?.usage?.refreshMinutes ?? 5;
  const providerOn = (id: UsageProviderId) => {
    const policy = POLICY_KEYS[id];
    return (
      settings.data?.usage?.providers?.[id] !== false &&
      (policy === undefined || settings.data?.usage?.[policy] === true)
    );
  };
  const providerPatch = (id: UsageProviderId, next: boolean) => {
    const policy = POLICY_KEYS[id];
    return policy === undefined
      ? { providers: { [id]: next } }
      : { providers: { [id]: next }, [policy]: next };
  };
  const busy = !settings.data || save.isPending;
  const setPanel = useCanvasStore((state) => state.setPanel);
  const providers = visibleUsageProviders(
    usage.data && usage.isError
      ? {
          providers: usage.data.providers.map((provider) => ({
            ...provider,
            status: "error" as const,
          })),
        }
      : usage.data,
  );

  return (
    <>
      <SettingsPageHeader
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              loading={refreshing}
              disabled={cooldown > 0 || !usageEnabled}
              onClick={() => refresh.mutate()}
            >
              {cooldown > 0
                ? t("usage.cooldown", { seconds: cooldown })
                : t("usage.refresh")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPanel("usage", "drawer");
                setPanel("settings", false);
              }}
            >
              {t("usage.dashboard.open")}
            </Button>
          </>
        }
      />

      {usageEnabled ? (
        <UsageKpis providers={providers} now={now} />
      ) : (
        <StatusPill role="status" tone="paused" label={t("usage.paused")} />
      )}
      {usageEnabled && (refreshFailed || usage.isError) && (
        <p role="status" className="text-meta text-danger-text">
          {t("usage.refreshError")}
        </p>
      )}

      <SettingsLoadable
        grouped
        loading={settings.isLoading}
        rows={6}
        control="switch"
      >
        <SettingsGroup>
          <SettingsRow label={t("settings.usageEnabled")}>
            <Switch
              checked={usageEnabled}
              disabled={busy}
              aria-label={t("settings.usageEnabled")}
              onCheckedChange={(next) => {
                save.mutate(
                  { usage: { enabled: next } },
                  {
                    onSuccess: () => {
                      if (next) refresh.mutate();
                      else
                        void queryClient.invalidateQueries({
                          queryKey: ["usage"],
                        });
                    },
                  },
                );
              }}
            />
          </SettingsRow>

          <SettingsRow label={t("settings.usageCadence")}>
            <Select
              value={String(refreshMinutes)}
              disabled={busy || !usageEnabled}
              onValueChange={(value) =>
                save.mutate({ usage: { refreshMinutes: Number(value) } })
              }
            >
              <SelectTrigger
                aria-label={t("settings.usageCadence")}
                size="sm"
                className={CONTROL_WIDTH}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REFRESH_CHOICES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes === 0
                      ? t("settings.cadence.manual")
                      : t("settings.cadence.minutes", { count: minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup>
          {PROVIDERS.map((id) => (
            <SettingsRow key={id} label={t(`usage.provider.${id}`)}>
              <Switch
                checked={providerOn(id)}
                disabled={busy || !usageEnabled}
                aria-label={t(`usage.provider.${id}`)}
                onCheckedChange={(next) =>
                  save.mutate(
                    { usage: providerPatch(id, next) },
                    {
                      onSuccess: () => {
                        refresh.mutate();
                        if (id === "copilot")
                          void queryClient.invalidateQueries({
                            queryKey: lk("copilot-auth"),
                          });
                      },
                    },
                  )
                }
              />
            </SettingsRow>
          ))}
          <SettingsRow label={t("settings.codexCliFallback")}>
            <Switch
              checked={cliFallback}
              disabled={busy || !usageEnabled}
              aria-label={t("settings.codexCliFallback")}
              onCheckedChange={(next) =>
                save.mutate({ usage: { codexCliFallback: next } })
              }
            />
          </SettingsRow>
          <SettingsRow label={t("usage.statusPage")}>
            <Switch
              checked={statusBadges}
              disabled={busy}
              aria-label={t("usage.statusPage")}
              onCheckedChange={(next) =>
                save.mutate(
                  { usage: { statusBadges: next } },
                  {
                    onSuccess: () =>
                      void queryClient.invalidateQueries({
                        queryKey: ["usage-status"],
                      }),
                  },
                )
              }
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow label={t("settings.costEnabled")}>
            <Switch
              checked={costEnabled}
              disabled={busy}
              aria-label={t("settings.costEnabled")}
              onCheckedChange={(next) =>
                save.mutate(
                  { usage: { cost: { enabled: next } } },
                  {
                    onSuccess: () =>
                      void queryClient.invalidateQueries({
                        queryKey: ["usage-cost"],
                      }),
                  },
                )
              }
            />
          </SettingsRow>
          <SettingsRow label={t("settings.claudeLocalWindow")}>
            <Switch
              checked={claudeLocalWindow}
              disabled={busy || !costEnabled}
              aria-label={t("settings.claudeLocalWindow")}
              onCheckedChange={(next) =>
                save.mutate(
                  { usage: { claudeLocalWindow: next } },
                  {
                    onSuccess: () =>
                      void queryClient.invalidateQueries({
                        queryKey: ["usage"],
                      }),
                  },
                )
              }
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow label={t("usage.catalogAutoRefresh")}>
            <Switch
              checked={catalogAutoRefresh}
              disabled={busy}
              aria-label={t("usage.catalogAutoRefresh")}
              onCheckedChange={(next) =>
                save.mutate({ models: { catalog: { autoRefresh: next } } })
              }
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsLoadable>

      <ModelCatalogPanel />
    </>
  );
}

export type { UsageProvider };
