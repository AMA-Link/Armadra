import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitLogCommit } from "@armadra/shared";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { cn } from "../../../lib/cn";
import { Loadable } from "../../../loading/Loadable";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Skeleton } from "../../../ui/skeleton";
import { Spinner } from "../../../ui/spinner";
import { EmptyState } from "../../../ui/state";
import { LANE_WIDTH, MAX_LANES, commitGraph, refBadges } from "../CommitGraph";
import { collapseLog, mergeLabel } from "./collapse";
import { CommitAuthor } from "./CommitAuthor";
import { commitAgents } from "./people";
import { branchColor, commitKey, logGraphKeys, repositoryColor } from "./graph";

/**
 * 提交图表格（Git 工具窗口设计 §2.2「提交图表格」）。
 *
 * 三件事决定了它必须是虚拟化的、而且图与行必须同源：
 *
 * 1. **行高固定 28px**（紧凑档 24px），滚到底自动续页。历史动辄上万行，
 *    一次全画出来的表格在滚动时会掉帧到没法用。
 * 2. **图只画可见区间**。车道布局仍然按**整页**算——车道是「哪个父提交还没
 *    出现」，只看可见的十几行会把跨出屏幕的线算错——但 `<path>` / `<circle>`
 *    只为可见行生成，所以 DOM 里始终只有几十个节点。
 * 3. **未提交的变更**是最上面一行虚线节点，占用行号 0；提交的行号因此整体
 *    下移一格，图的 y 也跟着移，否则线会连到错位的行上。
 */

/** 行高：常规 28px，紧凑 24px（§2.2 与工具栏的「紧凑行」）。 */
export const LOG_ROW_HEIGHT = 28;
export const LOG_COMPACT_ROW_HEIGHT = 24;

export interface LogTableProps {
  commits: readonly GitLogCommit[];
  /** 仓库路径 → 调色板序号；只有一个仓库时不画颜色条。 */
  colors: ReadonlyMap<string, number>;
  /** 被选中的行（`commitKey`）；`"uncommitted"` 是那条合成行。 */
  selected: string | null;
  /**
   * `additive`：⌘ / Ctrl 点击——日志页拿它做「两个提交比较」（组件规格 §7.7）。
   */
  onSelect: (
    key: string,
    commit: GitLogCommit | null,
    additive?: boolean,
  ) => void;
  /** 两个提交比较时的另一端：与选中行同样高亮，但浅一级。 */
  compareKey?: string | null;
  /** HEAD 有未提交变更的仓库；空 = 不显示那条虚线行。 */
  uncommitted: readonly string[];
  compact: boolean;
  showHash: boolean;
  /**
   * 手机宽度：只留「消息」和「日期」。作者与 hash 在 390px 里会把消息挤成
   * 三个字加省略号，而消息才是这一行存在的理由。
   */
  narrow?: boolean;
  /** 高亮我的提交时用来比对的邮箱；`null` = 不高亮。 */
  myEmail: string | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** 右键：把这一行交给菜单；合成行不触发。 */
  renderRowMenu?: (commit: GitLogCommit, row: ReactNode) => ReactNode;
  /**
   * 按第一父折叠（#927 B1）：合并只占一行，名下的分支提交收进计数里。
   * 缺省关：只有日志页按偏好打开，其它用到这张表的地方保持原样。
   */
  collapseMerges?: boolean;
  /**
   * 仓库 → 当前分支相对上游的领先 / 落后（#927 B2）。标在这个仓库带
   * `HEAD -> …` 的那一行上，不另开分支面板。
   */
  sync?: ReadonlyMap<string, { ahead: number; behind: number }>;
  /** GitHub 账号 id → 头像 data URL（#927 B3）。 */
  avatars?: ReadonlyMap<number, string>;
  /** 仓库路径 → 名字，悬停卡里用；单仓库时不传。 */
  repositoryNames?: ReadonlyMap<string, string>;
  /**
   * 突出哪一类提交（#927 B3）：其余的行降透明度，**不删行**——删行会让图断
   * 线，分支提交也会失去上下文。合并行看它名下的分支提交。
   */
  emphasis?: "all" | "mine" | "agent";
  /**
   * 仓库标识列收成细色条（#935）。只在多仓库时有这一列；切换只改列宽，
   * 不筛仓库、不动选中与滚动位置。
   */
  repositoryColumnCollapsed?: boolean;
  onToggleRepositoryColumn?: () => void;
  /** 滚到这一行（定位 HEAD、跳父提交）；`nonce` 变了就再滚一次。 */
  revealKey?: { key: string; nonce: number } | null;
  /** 「我的」看的邮箱（`git config user.email`）；与是否加粗高亮无关。 */
  identityEmail?: string | null;
  /** 展开的合并（`commitKey`）。 */
  expanded?: ReadonlySet<string>;
  onToggleMerge?: (key: string) => void;
}

const NONE: ReadonlySet<string> = new Set();
const NO_AVATARS: ReadonlyMap<number, string> = new Map();
/** 一行最多两枚引用徽标，其余折成 `+N`（#935）。 */
const MAX_BADGES = 2;

export const UNCOMMITTED_KEY = "uncommitted";

type Row =
  | { kind: "uncommitted"; key: string }
  | { kind: "commit"; key: string; commit: GitLogCommit };

/**
 * 时间列（#935）：今天、昨天说「今天 06:37」「昨天 21:10」，今年内说「11月3日
 * 21:10」，更早的才带年份。窄布局（手机）没有这一列的宽度，只留日期或时刻。
 */
export function formatWhen(
  iso: string,
  now: number,
  locale: string,
  labels: {
    today: (time: string) => string;
    yesterday: (time: string) => string;
  },
  narrow = false,
): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const day = (value: number) => new Date(value).toDateString();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  if (day(at) === day(now)) return narrow ? time : labels.today(time);
  if (day(at) === day(now - 24 * 60 * 60 * 1000)) {
    return narrow ? labels.yesterday("").trim() : labels.yesterday(time);
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: sameYear ? "short" : "numeric",
    day: "numeric",
  }).format(at);
  return narrow ? date : `${date} ${time}`;
}

/** 悬停看的完整时间：本地时区，带时区名（#935）。 */
function fullWhen(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(at);
}

/** 仓库标识列的宽度：展开显示名字，收起只剩一条细色条（#935）。 */
export const REPOSITORY_COLUMN_WIDTH = 112;
export const REPOSITORY_COLUMN_COLLAPSED = 12;

export function LogTable({
  commits,
  colors,
  selected,
  onSelect,
  uncommitted,
  compact,
  showHash,
  narrow = false,
  myEmail,
  hasMore,
  loading,
  onLoadMore,
  renderRowMenu,
  collapseMerges = false,
  sync,
  avatars = NO_AVATARS,
  repositoryNames,
  emphasis = "all",
  identityEmail: identity = null,
  repositoryColumnCollapsed = false,
  onToggleRepositoryColumn,
  revealKey = null,
  compareKey = null,
  expanded = NONE,
  onToggleMerge,
}: LogTableProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const scroller = useRef<HTMLDivElement | null>(null);
  const rowHeight = compact ? LOG_COMPACT_ROW_HEIGHT : LOG_ROW_HEIGHT;
  const multiRepository = colors.size > 1;

  const view = useMemo(
    () => collapseLog(commits, expanded, collapseMerges),
    [commits, expanded, collapseMerges],
  );
  const shown = view.commits;

  /** 带 Agent 的提交，以及名下有这种提交的合并：「Agent 协作」突出它们。 */
  const withAgent = useMemo(() => {
    const keys = new Set<string>();
    for (const commit of commits) {
      if (commitAgents(commit).length === 0) continue;
      const key = commitKey(commit);
      keys.add(key);
      const owner = view.mergedBy.get(key);
      if (owner) keys.add(owner);
    }
    return keys;
  }, [commits, view.mergedBy]);
  const identityEmail = identity?.toLowerCase() ?? null;
  const isMine = (commit: GitLogCommit) =>
    myEmail !== null &&
    commit.authorEmail.toLowerCase() === myEmail.toLowerCase();
  const dimmed = (commit: GitLogCommit) =>
    emphasis === "agent"
      ? !withAgent.has(commitKey(commit))
      : emphasis === "mine"
        ? identityEmail !== null &&
          commit.authorEmail.toLowerCase() !== identityEmail
        : false;

  const rows = useMemo<Row[]>(() => {
    const head: Row[] =
      uncommitted.length > 0
        ? [{ kind: "uncommitted", key: UNCOMMITTED_KEY }]
        : [];
    return [
      ...head,
      ...shown.map<Row>((commit) => ({
        kind: "commit",
        key: commitKey(commit),
        commit,
      })),
    ];
  }, [shown, uncommitted.length]);

  // 车道按整页算，行号偏移交给渲染：合成行不进图，但它占着第 0 行。
  const offset = rows.length - shown.length;
  const graph = useMemo(() => commitGraph(shown, logGraphKeys), [shown]);
  const lanes = Math.min(graph.lanes, MAX_LANES);
  // 多仓库时左边是仓库标识列，图从它右边起（#935）。
  // 手机宽度放不下带名字的一列：固定用细色条（规格「窄窗口优先压缩」）。
  const columnCollapsed = repositoryColumnCollapsed || narrow;
  const repositoryColumn = multiRepository
    ? columnCollapsed
      ? REPOSITORY_COLUMN_COLLAPSED
      : REPOSITORY_COLUMN_WIDTH
    : 0;
  const graphLeft = repositoryColumn + 4;
  const gutter = graphLeft + lanes * LANE_WIDTH + 12;

  /**
   * 主线用仓库色（单仓库就是品牌色）；分支车道轮换其余颜色，跳过品牌色，
   * 免得一条分支和主线撞色。
   */
  const repositoryHue = (path: string) =>
    repositoryColor(colors.get(path) ?? 0);
  const repositoryOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
  const branchHue = branchColor;
  const pointColor = (key: string, lane: number) =>
    view.mainline.has(key) ? repositoryHue(repositoryOf(key)) : branchHue(lane);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (!revealKey) return;
    const index = rows.findIndex((row) => row.key === revealKey.key);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
    // 只在请求变了时滚；行数变化（翻页）不该把视图拽回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  // 滚到底继续翻页。判据是「最后一个虚拟行进入了视野」，不是滚动位置：
  // 行高变了、窗口变了都不用重新调这个数。
  const last = items[items.length - 1];
  useEffect(() => {
    if (!hasMore || loading) return;
    if (last && last.index >= rows.length - 1) onLoadMore();
  }, [hasMore, loading, last, rows.length, onLoadMore]);

  const first = items[0]?.index ?? 0;
  const until = last?.index ?? 0;
  const visible = (row: number) =>
    row + offset >= first - 4 && row + offset <= until + 4;

  const x = (lane: number) =>
    graphLeft + Math.min(lane, MAX_LANES - 1) * LANE_WIDTH + 8;

  /**
   * 「未提交」挂在哪：第一个有改动的仓库在本页的第一行。那个仓库一行都没有
   * （被筛掉了）时退回第 0 条车道、不画连线。
   */
  const dirtyHead = useMemo(() => {
    const repository = uncommitted[0];
    if (repository === undefined) return null;
    const row = shown.findIndex((entry) => entry.repositoryPath === repository);
    const point =
      row < 0 ? undefined : graph.points.get(commitKey(shown[row]!));
    return {
      repository,
      lane: point?.lane ?? 0,
      row: point ? row : -1,
      color: repositoryColor(colors.get(repository) ?? 0),
    };
  }, [uncommitted, shown, graph, colors]);
  const y = (row: number) => (row + offset) * rowHeight + rowHeight / 2;

  /** 同一仓库连续的行合成一段（#935）；「未提交」那行算在脏仓库名下。 */
  const segments = useMemo(() => {
    if (!multiRepository) return [];
    const result: { repository: string; start: number; end: number }[] = [];
    rows.forEach((row, index) => {
      const repository =
        row.kind === "commit"
          ? row.commit.repositoryPath
          : (dirtyHead?.repository ?? null);
      if (repository === null) return;
      const last = result[result.length - 1];
      if (last && last.repository === repository && last.end === index - 1) {
        last.end = index;
      } else {
        result.push({ repository, start: index, end: index });
      }
    });
    return result;
  }, [rows, multiRepository, dirtyHead]);
  const original = useMemo(
    () => new Map(commits.map((commit) => [commitKey(commit), commit])),
    [commits],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Loadable
        loading={loading && commits.length === 0}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        skeleton={
          <LogTableSkeleton
            rowHeight={rowHeight}
            gutter={gutter}
            narrow={narrow}
            showHash={showHash}
            label={t("state.loading")}
          />
        }
      >
        <div
          ref={scroller}
          data-slot="git-log-rows"
          className="relative min-h-0 flex-1 overflow-auto"
        >
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {segments.map((segment) => {
              if (segment.end < first - 4 || segment.start > until + 4)
                return null;
              const color = repositoryHue(segment.repository);
              const name =
                repositoryNames?.get(segment.repository) ?? segment.repository;
              const hint = t(
                columnCollapsed
                  ? "gitLog.table.repositoryExpand"
                  : "gitLog.table.repositoryCollapse",
              );
              return (
                <Button
                  type="button"
                  variant="ghost"
                  key={`${segment.repository}:${segment.start}`}
                  data-slot="git-log-repository-segment"
                  data-repository={segment.repository}
                  aria-expanded={!columnCollapsed}
                  aria-label={`${name} · ${hint}`}
                  title={`${name}\n${segment.repository}\n${hint}`}
                  onClick={onToggleRepositoryColumn}
                  className="absolute left-0.5 z-20 h-auto min-w-0 cursor-pointer items-start justify-start overflow-hidden rounded-tight border-0 p-0 text-left font-normal hover:brightness-110"
                  style={{
                    top: segment.start * rowHeight + 1,
                    height: (segment.end - segment.start + 1) * rowHeight - 2,
                    width: repositoryColumn - 4,
                    background: columnCollapsed
                      ? "transparent"
                      : `color-mix(in oklab, ${color} 26%, var(--background))`,
                  }}
                >
                  {columnCollapsed ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-0.5 left-0.5 w-1 rounded-full"
                      style={{ background: color }}
                    />
                  ) : (
                    <span className="truncate px-2 pt-1 text-caption font-medium text-foreground">
                      {name}
                    </span>
                  )}
                </Button>
              );
            })}
            <svg
              aria-label={t("gitLog.table.graph")}
              role="img"
              // 压在行的上面：选中与悬停的底色不能把这一行的点和线盖掉。
              className="pointer-events-none absolute top-0 left-0 z-10"
              width={gutter}
              height={virtualizer.getTotalSize()}
            >
              {graph.edges.map((edge) => {
                if (!visible(edge.from.row) && !visible(edge.to?.row ?? -99))
                  return null;
                // 两端都在主线上 = 仓库色；否则用不在主线那一端的车道色，
                // 一段分支从分出到汇回始终是一个颜色。
                const sideEnd = !view.mainline.has(edge.child)
                  ? edge.from
                  : edge.to && !view.mainline.has(edge.parent)
                    ? edge.to
                    : null;
                const color = sideEnd
                  ? branchHue(sideEnd.lane)
                  : repositoryHue(repositoryOf(edge.child));
                return (
                  <path
                    key={`${edge.child}:${edge.parent}`}
                    data-child={edge.child}
                    data-parent={edge.parent}
                    fill="none"
                    stroke={color}
                    className="stroke-[1.5]"
                    strokeLinecap="round"
                    strokeDasharray={edge.to ? undefined : "3 3"}
                    d={
                      edge.to
                        ? `M${x(edge.from.lane)},${y(edge.from.row)} C${x(edge.from.lane)},${y(edge.from.row) + rowHeight * 0.5} ${x(edge.to.lane)},${y(edge.to.row) - rowHeight * 0.5} ${x(edge.to.lane)},${y(edge.to.row)}`
                        : `M${x(edge.from.lane)},${y(edge.from.row)} v${rowHeight * 0.5}`
                    }
                  />
                );
              })}
              {offset > 0 && dirtyHead && (
                // 未提交的变更：一个虚线空心点，落在脏的那个仓库的主线车道上，
                // 虚线接到这个仓库在表里的第一行（它的 HEAD）。
                <g
                  data-slot="git-log-uncommitted"
                  data-repository={dirtyHead.repository}
                >
                  <circle
                    cx={x(dirtyHead.lane)}
                    cy={rowHeight / 2}
                    r={3.5}
                    fill="var(--background)"
                    stroke={dirtyHead.color}
                    className="stroke-[1.5]"
                    strokeDasharray="2 2"
                  />
                  {dirtyHead.row >= 0 && (
                    <path
                      d={`M${x(dirtyHead.lane)},${rowHeight / 2 + 4} L${x(dirtyHead.lane)},${y(dirtyHead.row) - 6}`}
                      fill="none"
                      stroke={dirtyHead.color}
                      className="stroke-[1.5]"
                      strokeDasharray="3 3"
                    />
                  )}
                </g>
              )}
              {shown.map((commit, row) => {
                if (!visible(row)) return null;
                const key = commitKey(commit);
                const point = graph.points.get(key);
                if (!point) return null;
                const merge =
                  commit.parents.length > 1 || view.sideCount.has(key);
                const color = pointColor(key, point.lane);
                return (
                  <g
                    key={key}
                    data-commit={commit.oid}
                    data-repository={commit.repositoryPath}
                    data-merge={merge ? "true" : "false"}
                    data-mainline={view.mainline.has(key) ? "true" : "false"}
                  >
                    {/* 一圈底色晕圈：线从点下面穿过时，点仍然是完整的一颗。 */}
                    <circle
                      cx={x(point.lane)}
                      cy={y(point.row)}
                      r={6.5}
                      fill={`color-mix(in oklab, ${color} 28%, var(--background))`}
                    />
                    <circle
                      cx={x(point.lane)}
                      cy={y(point.row)}
                      r={selected === key ? 4.5 : 3.5}
                      fill={color}
                    />
                  </g>
                );
              })}
            </svg>
            {items.map((item) => {
              const row = rows[item.index]!;
              const body =
                row.kind === "uncommitted" ? (
                  <UncommittedRow
                    gutter={gutter}
                    height={rowHeight}
                    selected={selected === UNCOMMITTED_KEY}
                    onSelect={() => onSelect(UNCOMMITTED_KEY, null)}
                  />
                ) : (
                  <CommitRow
                    commit={row.commit}
                    side={collapseMerges && view.mergedBy.has(row.key)}
                    merge={
                      collapseMerges && view.sideCount.has(row.key)
                        ? {
                            count: view.sideCount.get(row.key)!,
                            open: expanded.has(row.key),
                            onToggle: () => onToggleMerge?.(row.key),
                          }
                        : null
                    }
                    toggleSlot={collapseMerges}
                    sync={
                      row.commit.refs.some((ref) => ref.startsWith("HEAD -> "))
                        ? (sync?.get(row.commit.repositoryPath) ?? null)
                        : null
                    }
                    gutter={gutter}
                    height={rowHeight}
                    merged={(original.get(row.key)?.parents.length ?? 0) > 1}
                    mine={isMine(row.commit)}
                    dimmed={dimmed(row.commit)}
                    author={
                      <CommitAuthor
                        commit={row.commit}
                        avatars={avatars}
                        repositoryName={
                          repositoryNames?.get(row.commit.repositoryPath) ??
                          null
                        }
                      />
                    }
                    showHash={showHash && !narrow}
                    narrow={narrow}
                    when={formatWhen(
                      row.commit.committerTime,
                      Date.now(),
                      locale,
                      {
                        today: (time) => t("gitLog.time.today", { time }),
                        yesterday: (time) =>
                          t("gitLog.time.yesterday", { time }),
                      },
                      narrow,
                    )}
                    fullWhen={fullWhen(row.commit.committerTime, locale)}
                    selected={selected === row.key || compareKey === row.key}
                    onSelect={(additive) =>
                      onSelect(row.key, row.commit, additive)
                    }
                  />
                );
              return (
                <div
                  key={row.key}
                  data-index={item.index}
                  className="absolute inset-x-0"
                  style={{
                    height: `${rowHeight}px`,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {row.kind === "commit" && renderRowMenu
                    ? renderRowMenu(row.commit, body)
                    : body}
                </div>
              );
            })}
          </div>
        </div>
      </Loadable>
      {hasMore && (
        <p
          role="status"
          className="flex h-(--row-h) shrink-0 items-center gap-1.5 border-t border-border px-3 text-caption text-muted-foreground"
        >
          {loading ? <Spinner size={12} /> : null}
          {t("gitLog.table.more")}
        </p>
      )}
      {!loading && rows.length === 0 && (
        <EmptyState inline title={t("gitLog.table.empty")} />
      )}
    </div>
  );
}

/**
 * 首批提交还没到：与 `CommitRow` 同行高，行首一个图谱圆点，再是消息、作者、日期
 * 三条（宽度同表头列：作者 w-28、日期 w-20、hash w-16）。
 */
function LogTableSkeleton({
  rowHeight,
  gutter,
  narrow,
  showHash,
  label,
}: {
  rowHeight: number;
  gutter: number;
  narrow: boolean;
  showHash: boolean;
  label: string;
}) {
  const MESSAGE = ["w-3/4", "w-2/3", "w-5/6", "w-1/2"] as const;
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="git-log-skeleton"
      className="flex min-h-0 flex-1 flex-col"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          data-slot="git-log-skeleton-row"
          className="relative flex shrink-0 items-center gap-2 pr-3"
          style={{ height: rowHeight, paddingLeft: gutter }}
        >
          <Skeleton className="absolute left-2 size-2 rounded-full" />
          <Skeleton className={cn("h-3 min-w-0", MESSAGE[index % 4])} />
          <div className="flex-1" />
          {!narrow && <Skeleton className="h-3 w-28 shrink-0" />}
          <Skeleton className="h-3 w-20 shrink-0" />
          {showHash && !narrow && <Skeleton className="h-3 w-16 shrink-0" />}
        </div>
      ))}
    </div>
  );
}

function UncommittedRow({
  gutter,
  height,
  selected,
  onSelect,
}: {
  gutter: number;
  height: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={selected}
      onClick={onSelect}
      style={{ height, paddingLeft: gutter }}
      className="h-auto justify-start rounded-none border-0 font-normal w-full min-w-0 gap-2 pr-3 text-left text-meta italic text-muted-foreground hover:bg-muted aria-pressed:bg-muted"
    >
      <span className="min-w-0 flex-1 truncate">
        {t("gitLog.table.uncommitted")}
      </span>
    </Button>
  );
}

function CommitRow({
  commit,
  side,
  merge,
  toggleSlot,
  sync,
  dimmed,
  author,
  gutter,
  height,
  merged,
  mine,
  showHash,
  narrow,
  when,
  fullWhen,
  selected,
  onSelect,
}: {
  commit: GitLogCommit;
  /** 合并带进来的分支提交：文字降一级。 */
  side: boolean;
  /** 折叠模式下的主线合并：右侧计数，点一下原地展开 / 收起。 */
  merge: { count: number; open: boolean; onToggle: () => void } | null;
  /** 折叠开着时每行都留出计数那一格，列才对得齐。 */
  toggleSlot: boolean;
  sync: { ahead: number; behind: number } | null;
  /** 不在当前「突出」范围里的行：降透明度，不删。 */
  dimmed: boolean;
  /** 作者列（头像 + 名字 + 悬停卡）。 */
  author: ReactNode;
  gutter: number;
  height: number;
  /** 合并提交（按原始父提交数）：标题降一级（#935）。 */
  merged: boolean;
  mine: boolean;
  showHash: boolean;
  narrow: boolean;
  when: string;
  /** 悬停看的完整时间与时区。 */
  fullWhen: string;
  selected: boolean;
  onSelect: (additive: boolean) => void;
}) {
  const t = useT();
  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  // 合并按主题文本认（#932），与名下有没有分支提交无关。
  const label = mergeLabel(commit.subject);
  return (
    <div
      data-selected={selected ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      className="group/row relative flex h-full w-full min-w-0 items-center hover:bg-muted data-selected:bg-muted data-dimmed:opacity-40"
    >
      <Button
        type="button"
        variant="ghost"
        aria-pressed={selected}
        data-commit={commit.oid}
        onClick={(event) => onSelect(event.metaKey || event.ctrlKey)}
        style={{ height, paddingLeft: gutter }}
        className={cn(
          "h-auto min-w-0 flex-1 justify-start gap-2 rounded-none border-0 bg-transparent pr-3 text-left text-meta font-normal hover:bg-transparent aria-pressed:bg-transparent",
          mine && "font-medium text-foreground",
          (side || merged) && "text-muted-foreground",
        )}
      >
        <span
          // 标题至少留 6rem：引用徽标多的行（`origin/main`、`origin/HEAD`…）在
          // 窄窗口里会把它挤成 0 宽，整行只剩徽标（#932）。
          className="min-w-24 flex-1 truncate"
          title={commit.subject}
          data-side={side ? "true" : undefined}
        >
          {label ? label.branch : commit.subject || commit.oid.slice(0, 12)}
          {label?.pr && (
            <span className="ml-1.5 text-muted-foreground">{label.pr}</span>
          )}
        </span>
        {/* 徽标放进一个可收缩、超出即裁掉的容器：标题保底宽度之后，剩下的
            空间不够时先裁徽标，时间列始终对齐（#935）。 */}
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
          {badges.slice(0, MAX_BADGES).map((badge) => (
            <Badge
              key={`${badge.kind}:${badge.label}`}
              title={badge.label}
              size="sm"
              variant={
                badge.kind === "tag"
                  ? "brand"
                  : badge.kind === "head"
                    ? "default"
                    : "outline"
              }
              className="max-w-28 min-w-0 justify-start truncate"
            >
              {badge.label}
            </Badge>
          ))}
          {badges.length > MAX_BADGES && (
            <Badge
              size="sm"
              variant="outline"
              data-slot="git-log-more-refs"
              title={badges
                .slice(MAX_BADGES)
                .map((badge) => badge.label)
                .join("\n")}
              className="shrink-0"
            >
              +{badges.length - MAX_BADGES}
            </Badge>
          )}
        </span>
        {sync && (sync.ahead > 0 || sync.behind > 0) && (
          <span
            data-slot="git-log-sync"
            className="shrink-0 text-caption text-muted-foreground tabular-nums"
            title={t("gitLog.table.sync", {
              ahead: sync.ahead,
              behind: sync.behind,
            })}
          >
            {sync.ahead > 0 && `↑${sync.ahead}`}
            {sync.ahead > 0 && sync.behind > 0 && " "}
            {sync.behind > 0 && `↓${sync.behind}`}
          </span>
        )}
        {!narrow && author}
        <span
          data-numeric
          className="w-24 shrink-0 truncate text-right text-muted-foreground"
          title={fullWhen}
        >
          {when}
        </span>
        {showHash && (
          <span className="w-16 shrink-0 truncate text-right font-mono text-muted-foreground">
            {commit.oid.slice(0, 7)}
          </span>
        )}
      </Button>
      {merge === null && toggleSlot && (
        <span aria-hidden className="mr-2 w-10 shrink-0" />
      )}
      {merge && (
        // 计数放在行尾、整行按钮之外：两个按钮不能嵌套，点计数也不该顺带
        // 选中这一行。
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-slot="git-log-merge-toggle"
          aria-expanded={merge.open}
          aria-label={t(
            merge.open
              ? "gitLog.table.collapseMerge"
              : "gitLog.table.expandMerge",
            { count: merge.count },
          )}
          onClick={merge.onToggle}
          className="mr-2 h-5 w-10 shrink-0 gap-0.5 px-1.5 text-caption tabular-nums"
        >
          {merge.count}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 transition-transform",
              merge.open && "rotate-180",
            )}
          />
        </Button>
      )}
    </div>
  );
}
