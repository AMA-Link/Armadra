import type { Usage, UsageProvider } from "@armadra/shared";

import { useT } from "../../../app/preferences-store";
import {
  usageEstimatePercent,
  usageLocalEstimate,
  usagePercent,
  usageResetLabel,
  usageWindowLabel,
} from "../../../lib/usage";
import { formatTokens } from "../../../lib/cost";
import { StatusPill } from "@/ui/status-pill";
import { SettingsKpi, SettingsKpiGrid } from "../SettingsKpi";

/**
 * 托盘里列哪些家：只有 `ok` 与 `error` 上托盘；`unavailable` 当作这台机器上没有这个
 * CLI——除非它带着本地估算（额度端点按政策关着，契约 §12.1）。与画布右上角的用量环同一规则。
 */
export function visibleUsageProviders(
  usage: Pick<Usage, "providers"> | undefined,
): UsageProvider[] {
  return (usage?.providers ?? []).filter(
    (provider) =>
      provider.status !== "unavailable" ||
      usageLocalEstimate(provider) !== null,
  );
}

/** 一个窗口的取数：名字、占用（没有为 `null`）、重置那一行。 */
interface Reading {
  label: string;
  percent: number | null;
  reset: string | null;
  tokens: number | null;
}

function readings(
  provider: UsageProvider,
  now: number,
  t: ReturnType<typeof useT>,
): Reading[] {
  const estimate = usageLocalEstimate(provider);
  if (estimate !== null)
    return estimate.map((window) => ({
      label: usageWindowLabel(t, window),
      percent: usageEstimatePercent(window),
      reset: null,
      tokens: window.used,
    }));
  if (provider.status !== "ok") return [];
  return provider.windows
    .filter((window) => window.unlimited !== true)
    .map((window) => ({
      label: usageWindowLabel(t, window),
      percent: usagePercent(provider, window, now),
      reset: usageResetLabel(t, window, now),
      tokens: null,
    }));
}

/**
 * 用量页的 KPI 托盘（设计系统 §5.17）：每个 provider 一张。大数字 = 各窗口里最高的占用
 * （额度端点关着时用本地估算），刻度 20 格按阈值 80 / 95 上色，元信息 = 窗口名 + 重置倒计时
 * （等宽）；Codex 有预付余额时多一行；取不到（`status: "error"`）时大数字 `—` 加「失败」
 * 状态胶囊。纯展示：数据由调用方给，不读 hook。
 */
export function UsageKpis({
  providers,
  now,
}: {
  providers: readonly UsageProvider[];
  now: number;
}) {
  const t = useT();
  if (providers.length === 0) return null;
  return (
    <SettingsKpiGrid>
      {providers.map((provider) => {
        const name = t(`usage.provider.${provider.id}`);
        const failed = provider.status === "error";
        const unlimited =
          provider.status === "ok" &&
          provider.windows.length > 0 &&
          provider.windows.every((window) => window.unlimited === true);
        const rows = failed ? [] : readings(provider, now, t);
        const numeric = rows.filter(
          (row): row is Reading & { percent: number } => row.percent !== null,
        );
        const top = numeric.reduce<(Reading & { percent: number }) | null>(
          (best, row) =>
            best === null || row.percent > best.percent ? row : best,
          null,
        );
        // 只有估算、不知道额度：报 token 数，不画刻度。
        const tokens =
          top === null
            ? (rows.find((row) => row.tokens !== null)?.tokens ?? null)
            : null;
        const estimating = usageLocalEstimate(provider) !== null;
        const shown = top ?? rows[0] ?? null;
        const value: number | string | null = failed
          ? null
          : top !== null
            ? Math.round(top.percent)
            : tokens !== null
              ? formatTokens(tokens)
              : unlimited
                ? t("usage.unlimited")
                : null;
        const balance = provider.credits?.balance;
        return (
          <SettingsKpi
            key={provider.id}
            data-provider={provider.id}
            label={name}
            value={value}
            format={(number) => t("usage.percent", { value: number })}
            percent={top?.percent ?? null}
            actions={
              failed ? (
                <StatusPill tone="failed" label={t("usage.status.error")} />
              ) : undefined
            }
            meta={
              <span className="flex min-w-0 flex-col gap-0.5">
                {shown !== null && (
                  <span className="truncate">
                    {shown.label}
                    {estimating ? ` · ${t("usage.estimate.local")}` : ""}
                    {shown.reset !== null && (
                      <>
                        {" · "}
                        <span className="font-mono">{shown.reset}</span>
                      </>
                    )}
                  </span>
                )}
                {balance !== undefined && (
                  <span className="truncate">
                    {t("usage.credits")}{" "}
                    <span className="font-mono">
                      {new Intl.NumberFormat().format(balance)}
                    </span>
                  </span>
                )}
              </span>
            }
          />
        );
      })}
    </SettingsKpiGrid>
  );
}
