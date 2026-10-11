import * as React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Release, ReleaseAsset, UpdateReleases } from "@armadra/shared";

import { runtimeApi } from "../../../../api/client";
import { useT } from "../../../../app/preferences-store";
import { formatBytes, formatRelativeTime } from "../../../../lib/format";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { packageAssets } from "../../../../updates/releases";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";

/** 发布历史的查询键：关于页里几处共用一份答案。 */
export const RELEASES_QUERY_KEY = ["update-releases"] as const;

/** core 每分钟至多真的问一次 GitHub；页面也不催得比这更勤。 */
export const REFRESH_COOLDOWN_MS = 60_000;

/**
 * 发布历史（契约 §64）与「刷新」。刷新绕过 core 的缓存，但在 `retryAfterMs`
 * （限流、连不上）与每分钟一次的冷却过去之前不可按。
 */
export function useReleases() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: RELEASES_QUERY_KEY,
    queryFn: () => runtimeApi.updateReleases(false),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshedAt, setRefreshedAt] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());

  const retryAfter = query.data?.error?.retryAfterMs ?? 0;
  const until = Math.max(
    refreshedAt + (refreshedAt > 0 ? REFRESH_COOLDOWN_MS : 0),
    retryAfter > 0 ? query.dataUpdatedAt + retryAfter : 0,
  );
  const coolingDown = until > now;

  React.useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => setNow(Date.now()), until - now + 50);
    return () => clearTimeout(timer);
  }, [coolingDown, until, now]);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await runtimeApi.updateReleases(true);
      client.setQueryData(RELEASES_QUERY_KEY, fresh);
    } catch {
      await query.refetch();
    } finally {
      const at = Date.now();
      setRefreshedAt(at);
      setNow(at);
      setRefreshing(false);
    }
  }, [client, query]);

  return {
    data: query.data ?? null,
    failed: query.isError && !query.data,
    loading: query.isPending,
    refreshing,
    coolingDown,
    refresh,
  };
}

/**
 * 关于页的「版本历史」：每个发布一行，展开是说明（Markdown）、GitHub 发布页与
 * 本平台可用的安装包。只给链接，不提供装旧版本的动作（迁移只进不退）。
 */
export function ReleaseHistory({
  data,
  current,
  latest,
  failed = false,
  refreshing = false,
  coolingDown = false,
  onRefresh,
  onOpen,
  assets = () => [],
}: {
  data: UpdateReleases | null;
  /** 标「当前」的版本；手机上是 App 的版本，别处是 core 的。 */
  current: string;
  /** 标「最新」的版本；没有更新的是 `null`。 */
  latest: string | null;
  failed?: boolean;
  refreshing?: boolean;
  coolingDown?: boolean;
  onRefresh?: () => void;
  onOpen: (url: string) => void;
  /** 这个环境用得上的下载（桌面按平台、Android 的 APK）；默认不列。 */
  assets?: (release: Release) => ReleaseAsset[];
}) {
  const t = useT();
  const error = data?.error ?? null;
  return (
    <>
      <SettingsGroup title={t("updates.history")}>
        <SettingsRow label={t("updates.history.checkedAt")}>
          <div className="flex items-center gap-3">
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {data?.checkedAt
                ? formatRelativeTime(data.checkedAt)
                : t("updates.history.never")}
            </span>
            {onRefresh && (
              <Button
                size="sm"
                variant="secondary"
                disabled={refreshing || coolingDown}
                onClick={onRefresh}
              >
                {refreshing && <Spinner aria-hidden />}
                {t("updates.history.refresh")}
              </Button>
            )}
          </div>
        </SettingsRow>
        {data && data.releases.length > 0 ? (
          <Accordion type="single" collapsible className="px-4">
            {data.releases.map((release) => (
              <ReleaseItem
                key={release.tag}
                release={release}
                current={release.version === current}
                latest={release.version === latest}
                assets={assets(release)}
                onOpen={onOpen}
              />
            ))}
          </Accordion>
        ) : (
          <SettingsRow
            label={
              <span className="text-muted-foreground">
                {t(
                  failed
                    ? "updates.history.loadFailed"
                    : "updates.history.empty",
                )}
              </span>
            }
          />
        )}
      </SettingsGroup>
      {error && (
        <p
          data-slot="releases-error"
          className="text-[13px] leading-5 text-muted-foreground"
        >
          {t(`updates.history.error.${error.code}`)}
        </p>
      )}
      {error && error.retryAfterMs > 0 && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t("updates.retryAfter", {
            value: Math.ceil(error.retryAfterMs / 60_000),
          })}
        </p>
      )}
    </>
  );
}

function ReleaseItem({
  release,
  current,
  latest,
  assets,
  onOpen,
}: {
  release: Release;
  current: boolean;
  latest: boolean;
  assets: ReleaseAsset[];
  onOpen: (url: string) => void;
}) {
  const t = useT();
  const date = new Date(release.publishedAt);
  return (
    <AccordionItem value={release.tag} data-release={release.version}>
      <AccordionTrigger className="items-center gap-3 py-3 font-normal hover:no-underline">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-[13px] tabular-nums text-foreground">
            {release.version}
          </span>
          {current && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
              {t("updates.history.current")}
            </Badge>
          )}
          {latest && (
            <Badge className="h-5 px-1.5 text-[11px]">
              {t("updates.history.latest")}
            </Badge>
          )}
          {release.prerelease && (
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              {t("updates.channel.beta")}
            </Badge>
          )}
        </span>
        {!Number.isNaN(date.getTime()) && (
          <time
            dateTime={release.publishedAt}
            className="text-[12px] tabular-nums text-muted-foreground"
          >
            {t("time.yearMonthDay", {
              year: date.getFullYear(),
              month: date.getMonth() + 1,
              day: date.getDate(),
            })}
          </time>
        )}
      </AccordionTrigger>
      <AccordionContent className="flex flex-col gap-3">
        {release.notes.trim() !== "" && (
          <ReleaseNotes source={release.notes} onOpen={onOpen} />
        )}
        <div className="flex flex-wrap gap-2">
          {release.url.startsWith("https://") && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onOpen(release.url)}
            >
              {t("updates.history.open")}
            </Button>
          )}
          {packageAssets({ ...release, assets }).map((asset) => (
            <Button
              key={asset.name}
              size="sm"
              variant="secondary"
              onClick={() => onOpen(asset.url)}
            >
              <span className="truncate">{asset.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatBytes(asset.size)}
              </span>
            </Button>
          ))}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

/** 只放行 https；`javascript:`、相对地址、`data:` 一律丢掉。 */
export function releaseNoteUrl(url: string): string {
  return /^https:\/\//i.test(url) ? url : "";
}

/**
 * 发布说明：与评论同一条 Markdown 管线（`react-markdown` + GFM、`sticky-markdown`
 * 样式），不渲染裸 HTML，不加载图片（只留替代文字），链接经外部浏览器打开。
 */
export function ReleaseNotes({
  source,
  onOpen,
}: {
  source: string;
  onOpen: (url: string) => void;
}) {
  const components = React.useMemo<Components>(
    () => ({
      a: ({ href, children }) =>
        typeof href === "string" && href !== "" ? (
          <a
            href={href}
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault();
              onOpen(href);
            }}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        ),
      img: ({ alt }) => (alt ? <span>{alt}</span> : null),
    }),
    [onOpen],
  );
  return (
    <div
      data-slot="release-notes"
      className="sticky-markdown text-[13px] leading-relaxed break-words text-foreground"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={releaseNoteUrl}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
}
