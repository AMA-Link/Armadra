import type { UsageProvider } from "@armadra/shared";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { LocalEstimate } from "../panels/usage/LocalEstimate";
import { Progress, progressToneFor } from "../ui/progress";
import {
  UNAVAILABLE_REASONS,
  usageLocalEstimate,
  usageIsStale,
  usagePercent,
  usageReasonKey,
  usageResetLabel,
  usageWindowLabel,
} from "../lib/usage";

/** One consistent quota presentation for the canvas and account settings. */
export function ProviderDetail({
  provider,
  now,
  showCredentialSource = false,
}: {
  provider: UsageProvider;
  now: number;
  showCredentialSource?: boolean;
}) {
  const t = useT();
  const fetchedAt = Date.parse(provider.fetchedAt ?? "");
  const estimate = usageLocalEstimate(provider);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-body font-medium">
            {t(`usage.provider.${provider.id}`)}
          </span>
          {Number.isFinite(fetchedAt) && (
            <time
              dateTime={provider.fetchedAt!}
              className="text-meta text-muted-foreground"
              title={new Date(fetchedAt).toLocaleString()}
            >
              {t("usage.updated", {
                value: formatRelativeTime(fetchedAt, now),
              })}
            </time>
          )}
        </div>
        {showCredentialSource &&
          provider.credentialSource &&
          provider.credentialSource !== "none" && (
            <span className="text-meta text-muted-foreground">
              {t("settings.credentialSource")} ·{" "}
              {t(`settings.credential.${provider.credentialSource}`)}
            </span>
          )}
      </div>
      {provider.status === "unavailable" &&
      UNAVAILABLE_REASONS.has(provider.reason ?? "") ? (
        <>
          <p className="text-meta leading-relaxed text-muted-foreground">
            {t(usageReasonKey(provider.reason))}
          </p>
          {estimate && (
            <LocalEstimate provider={provider} windows={estimate} now={now} />
          )}
        </>
      ) : provider.status !== "ok" ? (
        <p className="text-meta leading-relaxed text-muted-foreground">
          {t(
            provider.status === "error"
              ? "usage.status.error"
              : "usage.status.unavailable",
          )}
          {provider.status === "error" && (
            <span className="block">
              {t(usageReasonKey(provider.reason), {
                provider: t(`usage.provider.${provider.id}`),
              })}
            </span>
          )}
        </p>
      ) : (
        <>
          {usageIsStale(provider, now) && (
            <p className="text-meta text-warn-text">{t("usage.stale")}</p>
          )}
          {provider.windows.map((window) => {
            const percent = usagePercent(provider, window, now);
            const name = usageWindowLabel(t, window);
            const resetAt = Date.parse(window.resetsAt ?? "");
            return (
              <div key={window.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-meta">
                  <span className="min-w-0 break-words text-muted-foreground">
                    {name}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {percent === null
                      ? "—"
                      : t("usage.used", { value: Math.round(percent) })}
                  </span>
                </div>
                <Progress
                  value={percent}
                  tone={progressToneFor(percent ?? 0)}
                  aria-label={`${t(`usage.provider.${provider.id}`)} · ${name}`}
                  aria-valuetext={
                    percent === null
                      ? t("usage.stale")
                      : t("usage.used", { value: Math.round(percent) })
                  }
                />
                <span
                  className="text-meta text-muted-foreground"
                  title={
                    Number.isFinite(resetAt)
                      ? new Date(resetAt).toLocaleString()
                      : undefined
                  }
                >
                  {usageResetLabel(t, window, now)}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
