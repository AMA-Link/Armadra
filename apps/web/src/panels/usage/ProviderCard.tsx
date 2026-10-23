import type { UsageProvider } from "@armadra/shared";

import { useT } from "../../app/preferences-store";
import { formatRelativeTime } from "../../lib/format";
import { paceDelta } from "../../lib/cost";
import {
  usageIsStale,
  usageLocalEstimate,
  usagePercent,
  usageReasonKey,
  usageResetLabel,
  usageWindowLabel,
} from "../../lib/usage";
import { Badge } from "@/ui/badge";
import { Progress, progressToneFor } from "@/ui/progress";
import { Tray, TrayCard, TrayHeader, TrayValue } from "@/ui/tray";
import { LocalEstimate } from "./LocalEstimate";
import { useProviderIncident } from "./provider-status";

/**
 * 用量看板里的 Provider 卡（§4.2）。
 *
 * 和用量球共用 `lib/usage` 的判定，但多三件事：pace（按时间推算的预期
 * 用量）、credits 余额、以及数字是否来自本地 CLI 回退。
 *
 * `unavailable / error / stale` 一律显示状态文字，不显示 0；`error` 再补一句
 * 原因（登录过期、连不上、401 …），与画布弹层 `shell/ProviderDetail` 同一套键。
 */
export function ProviderCard({
  provider,
  now,
}: {
  provider: UsageProvider;
  now: number;
}) {
  const t = useT();
  const name = t(`usage.provider.${provider.id}`);
  const fetchedAt = Date.parse(provider.fetchedAt ?? "");
  const stale = provider.status === "ok" && usageIsStale(provider, now);
  const incident = useProviderIncident(provider.id);
  const estimate = usageLocalEstimate(provider);

  return (
    <Tray
      data-slot="usage-provider-card"
      data-provider={provider.id}
      aria-label={name}
    >
      <TrayHeader
        label={name}
        actions={
          <>
            {/* 状态页报了故障或维护才出现；原文（英文）只放在悬停提示里。 */}
            {incident && (
              <Badge
                data-slot="usage-incident"
                data-indicator={incident.indicator}
                variant={
                  incident.indicator === "maintenance"
                    ? "secondary"
                    : "destructive"
                }
                title={incident.description}
              >
                {t(`usage.incident.${incident.indicator}`)}
              </Badge>
            )}
            {provider.status === "ok" && Number.isFinite(fetchedAt) && (
              <time
                dateTime={provider.fetchedAt!}
                title={new Date(fetchedAt).toLocaleString()}
                className="shrink-0 text-meta text-muted-foreground"
              >
                {t("usage.updated", {
                  value: formatRelativeTime(fetchedAt, now),
                })}
              </time>
            )}
          </>
        }
      />

      {estimate ? (
        <TrayCard>
          <p className="text-meta text-muted-foreground">
            {t(usageReasonKey(provider.reason))}
          </p>
          <LocalEstimate provider={provider} windows={estimate} now={now} />
        </TrayCard>
      ) : provider.status !== "ok" ? (
        <TrayCard>
          <p className="text-meta text-muted-foreground">
            {t(
              provider.status === "error"
                ? "usage.status.error"
                : "usage.status.unavailable",
            )}
            {/* 原因代码来自 Runtime（`reason`）；没有的按通用原因说。 */}
            {provider.status === "error" && (
              <span className="block">
                {t(usageReasonKey(provider.reason), { provider: name })}
              </span>
            )}
            {/*
              「没有凭据」也要说怎么办：登录入口恰好不在这块面板里，
              Copilot 在设置页，其余在各自的 CLI。
            */}
            {provider.status !== "error" && (
              <span className="block">
                {t(
                  provider.id === "copilot"
                    ? "usage.status.unavailableHint.copilot"
                    : "usage.status.unavailableHint",
                  { provider: name },
                )}
              </span>
            )}
          </p>
        </TrayCard>
      ) : (
        <>
          {(stale || provider.viaCli || provider.credits) && (
            <TrayCard>
              {stale && (
                <p className="text-meta text-warn-text">{t("usage.stale")}</p>
              )}
              {provider.viaCli && (
                <p className="text-meta text-muted-foreground">
                  {t("usage.viaCli")}
                </p>
              )}
              {provider.credits && (
                <div className="flex items-baseline justify-between gap-3 text-meta">
                  <span className="text-muted-foreground">
                    {t("usage.credits")}
                  </span>
                  <span className="font-medium tabular-nums">
                    {provider.credits.balance.toFixed(2)}
                  </span>
                </div>
              )}
            </TrayCard>
          )}
          {provider.windows.map((window) => {
            const percent = usagePercent(provider, window, now);
            const label = usageWindowLabel(t, window);
            const pace = window.unlimited ? null : paceDelta(window, now);
            return (
              <TrayCard key={window.key}>
                <div className="flex items-baseline justify-between gap-3 text-meta">
                  <span className="min-w-0 break-words text-muted-foreground">
                    {label}
                  </span>
                  {pace !== null && percent !== null && (
                    <span
                      data-slot="usage-pace"
                      data-ahead={pace > 0 || undefined}
                      className="shrink-0 tabular-nums data-[ahead]:text-warn-text"
                    >
                      {t(pace > 0 ? "usage.paceAhead" : "usage.paceBehind", {
                        value: Math.abs(pace),
                      })}
                    </span>
                  )}
                </div>
                <TrayValue
                  label={label}
                  value={window.unlimited ? t("usage.unlimited") : percent}
                  format={(value) => `${Math.round(value)}%`}
                />
                {!window.unlimited && (
                  <Progress
                    variant="ticks"
                    value={percent}
                    tone={progressToneFor(percent ?? 0)}
                    data-level={
                      percent === null
                        ? undefined
                        : percent >= 95
                          ? "danger"
                          : percent >= 80
                            ? "warn"
                            : "normal"
                    }
                    aria-label={`${name} · ${label}`}
                    aria-valuetext={
                      percent === null
                        ? t("usage.stale")
                        : t("usage.used", { value: Math.round(percent) })
                    }
                  />
                )}
                <span className="text-meta text-muted-foreground">
                  {window.unlimited
                    ? t("usage.resetUnknown")
                    : usageResetLabel(t, window, now)}
                </span>
              </TrayCard>
            );
          })}
        </>
      )}
    </Tray>
  );
}
