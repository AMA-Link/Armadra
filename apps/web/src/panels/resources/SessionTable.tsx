/**
 * 会话表（T02，终端宿主设计 §8「Session」行）。
 *
 * 三条约束写在这里，因为它们都是「不要」：
 *  - 测不出来的格子是短横线，不是 0；
 *  - 内存是进程树 RSS 之和，标为**估计**，不叫「独占内存」；
 *  - 面板不会自动杀任何会话，结束是用户点的，而且要再确认一次；
 *  - 进程已经不在的会话不占一行，直接从列表里消失。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Crosshair, X } from "lucide-react";
import type { SessionResources } from "@armadra/shared";

import { sessionGateway } from "@/session";
import { useT } from "@/app/preferences-store";
import { centerNode } from "@/sessions/SessionRow";
import { useCanvasStore } from "@/store/canvas-store";
import { toast } from "@/ui/toast";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { usePreferencesStore } from "@/app/preferences-store";
import { ProcessTree } from "./ProcessTree";
import { crossedThreshold } from "./memory-alert";
import {
  LOCAL_HOST,
  executionHosts,
  formatCount,
  formatMetricBytes,
  formatPercent,
  isIdleSession,
  liveSessions,
  sessionsOnHost,
  sortSessions,
  unknownReasonKey,
  type SessionSort,
} from "./metrics";
import { Button } from "@/ui/button";
import { cn } from "@/lib/cn";

export function SessionTable({
  sessions,
  sort,
  onSorted,
  host: controlledHost,
  onHost,
  extraHosts = [],
  hostName = (id) => id,
}: {
  sessions: readonly SessionResources[];
  sort: SessionSort;
  onSorted: (sort: SessionSort) => void;
  /** 由抽屉持有时，主机总览与会话表跟着同一个筛选走。 */
  host?: string | null | "all";
  onHost?: (host: string | null | "all") => void;
  /** 没有会话、但工作空间牵涉到的远端主机，也要能被选中看总览。 */
  extraHosts?: readonly string[];
  hostName?: (id: string) => string;
}) {
  const t = useT();
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const workspaceHostId = useCanvasStore(
    (state) => state.workspace?.executionHostId,
  );
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const [ending, setEnding] = useState<SessionResources | null>(null);
  // `"all"` 或者一个具体主机；`null` 是「判不出来的那些」。
  const [ownHost, setOwnHost] = useState<string | null | "all">("all");
  const host = controlledHost ?? ownHost;
  const setHost = onHost ?? setOwnHost;
  // 展开的会话；默认全收起，因为大多数会话下面只有一个 shell。
  const [showIdle, setShowIdle] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const threshold = usePreferencesStore(
    (state) => state.sessionMemoryWarnBytes,
  );

  const titleOf = (session: SessionResources) =>
    nodes?.find((node) => node.id === session.nodeId)?.title ??
    session.cwd.split("/").pop() ??
    session.sessionId.slice(0, 8);

  // 结束了的会话不留占位行：进程不在了就从列表消失（`liveSessions`）。
  const live = liveSessions(sessions);
  const seen = executionHosts(live, nodes, workspaceHostId);
  const hosts = [
    ...seen,
    ...extraHosts.filter((entry) => !seen.includes(entry)),
  ];
  const rows = sortSessions(
    sessionsOnHost(live, host, nodes, workspaceHostId),
    sort,
    titleOf,
  );
  const isHigh = (session: SessionResources) =>
    crossedThreshold(session.memoryBytes, threshold);
  const idleCount = rows.filter((row) =>
    isIdleSession(row, isHigh(row)),
  ).length;
  const visibleRows = showIdle
    ? rows
    : rows.filter((row) => !isIdleSession(row, isHigh(row)));
  const hostLabel = (value: string | null) => {
    if (value === null) return t("resources.host.filter.unknown");
    if (value === LOCAL_HOST) return t("resources.host.filter.local");
    return hostName(value);
  };

  const endSession = (session: SessionResources) => {
    setEnding(null);
    void sessionGateway
      .terminate(
        useCanvasStore.getState().workspace?.id ?? "",
        session.sessionId,
        "session",
      )
      .catch(() => toast.error(t("resources.endFailed")));
  };

  // 执行主机过滤只在真的有第二台主机时出现：一台机器上的「全部主机」是一个
  // 只有一个选项的控件。一行会话都没有时也要有它——它同时管上面的主机总览，
  // 远端工作空间还没开终端时正是要看远端那张卡的时候。
  const filter = hosts.length > 1 && (
    <div className="flex items-center gap-1 pb-1">
      {(["all", ...hosts] as const).map((value) => (
        <Button
          variant="ghost"
          size="xs"
          key={value === "all" ? "all" : (value ?? "unknown")}
          type="button"
          data-slot="resource-host-filter"
          data-host={value === "all" ? "all" : (value ?? "unknown")}
          data-active={host === value ? "true" : undefined}
          onClick={() => setHost(value)}
          className="block h-auto max-w-32 truncate rounded-control px-1.5 py-0.5 text-caption font-normal text-muted-foreground hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-strong"
        >
          {value === "all" ? t("resources.host.filter.all") : hostLabel(value)}
        </Button>
      ))}
    </div>
  );

  if (live.length === 0) return <>{filter}</>;

  return (
    <>
      {filter}

      <div className="flex items-center gap-1 pb-1">
        {/* 排序只换看的顺序，测不出来的一律排在最后，不当 0 混进来。 */}
        {(["cpu", "memory", "name"] as const).map((key) => (
          <Button
            variant="ghost"
            size="xs"
            key={key}
            type="button"
            onClick={() => onSorted(key)}
            data-active={sort === key ? "true" : undefined}
            className="h-auto rounded-control px-1.5 py-0.5 text-caption font-normal text-muted-foreground hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-strong"
          >
            {t(`resources.sort.${key}`)}
          </Button>
        ))}
      </div>

      <ul className="flex flex-col gap-0.5">
        {visibleRows.map((session) => {
          const reasonKey = unknownReasonKey(session.unknownReason);
          // 高占用只是高亮：面板不会自动结束任何会话（设计 §8）。
          const high = crossedThreshold(session.memoryBytes, threshold);
          const open = expanded.has(session.sessionId);
          const expandable = session.children.length > 0;
          const detail = reasonKey
            ? t(reasonKey)
            : [
                t("resources.session.children", {
                  count: formatCount(session.childCount),
                }),
                session.state,
                // 不让「pid」和号码被折到两行。
                typeof session.pid === "number"
                  ? `pid\u00a0${session.pid}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
          return (
            <li
              key={session.sessionId}
              data-high={high ? "true" : undefined}
              title={detail}
              className="group flex flex-col rounded-control px-1.5 py-1 hover:bg-accent data-[high=true]:bg-danger/8"
            >
              {/*
                两行：名字一行独占（只给操作按钮让位），说明与数字一行。原来四样挤
                在一行，抽屉里留给名字和说明的只有一百来像素，「MacBookPr…」
                「子进程 5 · sle…」全被截断。现在说明可以折行，名字放不下时悬停看全名。
              */}
              <div className="flex w-full items-center gap-2">
                {expandable ? (
                  <IconButton
                    label={
                      open
                        ? t("resources.session.treeCollapse")
                        : t("resources.session.tree")
                    }
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (!next.delete(session.sessionId))
                          next.add(session.sessionId);
                        return next;
                      })
                    }
                  >
                    {open ? <ChevronDown /> : <ChevronRight />}
                  </IconButton>
                ) : (
                  <span aria-hidden="true" className="size-[24px] shrink-0" />
                )}
                <div
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  title={titleOf(session)}
                >
                  <span className="truncate text-meta">{titleOf(session)}</span>
                  {session.location === "remote" && (
                    <Badge variant="outline" className="text-caption">
                      {t("resources.location.remote")}
                    </Badge>
                  )}
                  {high && (
                    <Badge
                      variant="outline"
                      className="border-danger text-caption text-danger-text"
                    >
                      {t("resources.session.high")}
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  {session.nodeId && (
                    <IconButton
                      label={t("resources.session.locate")}
                      onClick={() => {
                        selectNodes([session.nodeId!]);
                        centerNode(session.nodeId!);
                      }}
                    >
                      <Crosshair />
                    </IconButton>
                  )}
                  {/* 列表里除了休眠的都还在跑，所以「结束」对它们总是可按的；
                      休眠的进程早就不在了，没有什么可结束。 */}
                  {session.unknownReason !== "hibernated" && (
                    <IconButton
                      label={t("resources.session.end")}
                      onClick={() => setEnding(session)}
                    >
                      <X />
                    </IconButton>
                  )}
                </div>
              </div>
              <div className="flex w-full items-center gap-2 pl-8">
                <span className="flex-1" />
                <span className="w-14 shrink-0 text-right text-meta tabular-nums">
                  {formatPercent(session.cpuPercent)}
                </span>
                <span
                  className={cn(
                    "w-20 shrink-0 text-right text-meta tabular-nums",
                    high && "text-danger-text",
                  )}
                >
                  {formatMetricBytes(session.memoryBytes)}
                  {session.memoryEstimated && session.memoryBytes !== null ? (
                    <span className="ml-0.5 text-muted-foreground">≈</span>
                  ) : null}
                </span>
              </div>
              {open && (
                <ProcessTree
                  processes={session.children}
                  total={session.childCount}
                />
              )}
            </li>
          );
        })}
      </ul>

      {idleCount > 0 && (
        <Button
          variant="ghost"
          size="xs"
          type="button"
          data-slot="resource-idle-toggle"
          aria-expanded={showIdle}
          onClick={() => setShowIdle((current) => !current)}
          className="mt-1 text-caption font-normal text-muted-foreground"
        >
          {showIdle ? <ChevronDown /> : <ChevronRight />}
          {t("resources.idle", { count: idleCount })}
        </Button>
      )}

      <ResponsiveAlertDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
      >
        <ResponsiveAlertDialogContent aria-describedby={undefined}>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("resources.endTitle", {
                name: ending ? titleOf(ending) : "",
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("resources.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={() => ending && endSession(ending)}
            >
              {t("resources.session.end")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
