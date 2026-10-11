/**
 * 终端节点头部的内存徽标（路线图 §4.3）。
 *
 * 一个数字，比如 `512 MB`。它回答的是「这个会话现在占多少」，所以：
 *
 * - 数字是**进程树 RSS 之和**，是估计值。共享页会被每个进程各算一次，所以
 *   它不是「独占内存」，Popover 里说明这一点（设计 §8）。
 * - 测不出来显示 `unknown`，不显示 0——0 的意思是「量到了，是零」，那是另
 *   一句话，而且是假的。
 * - 越过阈值只变色，不做任何处置：不终止、不休眠、不压缩。越线由 core 判、
 *   经 `resources.threshold` 报来（`threshold-alerts.ts`，提醒也在那里发）；
 *   徽标只看这个会话有没有被报过、样本回落到九成以下没有。
 *
 * **看不见的节点不催 Runtime 快采。** 节点折叠、滚出视口或者整个窗口切到
 * 后台时，徽标把自己的订阅节奏降到 30 秒；重新看得见就恢复。节奏是全局取
 * 最快的一档，所以一个可见的徽标就够把大家拉回正常速度。
 */
import * as React from "react";
import type { SessionResources } from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { formatMetricBytes, formatPercent, UNKNOWN } from "./metrics";
import { stillOver, useThresholdStore } from "./threshold-alerts";
import { useSessionResources } from "./use-resources";
import { useOnScreen, usePageVisible } from "./use-visibility";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/cn";
import { HEADER_CHIP_CLASS } from "@/nodes/header-chip";

export interface MemoryBadgeProps {
  nodeId: string;
  workspaceId: string | null;
  sessionId: string | null;
  generation: number | null;
  /** 节点自己知道的可见性：折叠 / 已退出的节点不需要快节奏。 */
  visible: boolean;
  /** 测试注入：core 还没报过越线时显示的阈值；缺省是本机偏好。 */
  thresholdBytes?: number;
}

export function MemoryBadge({
  nodeId,
  workspaceId,
  sessionId,
  generation,
  visible,
  thresholdBytes,
}: MemoryBadgeProps) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.sessionMemoryWarnBytes);

  const anchor = React.useRef<HTMLButtonElement>(null);
  // 没有会话时下面提前 `return null`，按钮不在 DOM 上；会话 id 到了的那次提交
  // 才挂观察器（见 `useOnScreen` 的 `enabled`）。
  const onScreen = useOnScreen(anchor, Boolean(sessionId));
  const pageVisible = usePageVisible();
  const watched = visible && onScreen && pageVisible;
  const cadence = watched ? "fast" : "slow";
  // 只认这个会话这一代的行（换代之后旧行的数字属于另一次运行），而且只在
  // **这一行**变了的时候才重渲——整份快照进 state 的写法会让一屏三十个徽标
  // 每个采样 tick 全部重画一遍（见 `use-resources.ts` 的 `useSessionResources`）。
  const session: SessionResources | null = useSessionResources(
    workspaceId,
    sessionId,
    generation,
    cadence,
  );

  const memory = session?.memoryBytes ?? null;
  const reported = useThresholdStore((state) =>
    sessionId ? state.over[sessionId] : undefined,
  );
  // 阈值以 core 报来的为准；没报过时显示本机偏好（设置页同时写这两处）。
  const threshold = reported?.threshold ?? thresholdBytes ?? stored;
  const over = stillOver(reported, memory);

  // 回落到九成以下：忘掉这次越线，下次再越线 core 会重新报。
  React.useEffect(() => {
    if (reported && sessionId && !over) {
      useThresholdStore.getState().forget(sessionId);
    }
  }, [reported, sessionId, over]);

  if (!sessionId) return null;

  const value = formatMetricBytes(memory);
  const known = value !== UNKNOWN;
  const label = known ? value : t("resources.memory.unknown");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className={cn(
            HEADER_CHIP_CLASS,
            "font-normal",
            over && "text-[var(--danger-text)]",
          )}
          data-no-drag="true"
        >
          <Button
            variant="ghost"
            size="xs"
            ref={anchor}
            type="button"
            data-testid={`memory-badge-${nodeId}`}
            data-over={over ? "true" : undefined}
            aria-label={t("resources.memory.badge", { value: label })}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="whitespace-nowrap">{label}</span>
          </Button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 max-w-[calc(100vw-1rem)] text-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="font-medium">{t("resources.memory.title")}</h3>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">
            {t("resources.memory.value")}
          </dt>
          <dd className="m-0 text-right">{label}</dd>
          <dt className="text-muted-foreground">{t("resources.host.cpu")}</dt>
          <dd className="m-0 text-right">
            {formatPercent(session?.cpuPercent)}
          </dd>
          <dt className="text-muted-foreground">
            {t("resources.memory.children")}
          </dt>
          <dd className="m-0 text-right">{session?.childCount ?? UNKNOWN}</dd>
          <dt className="text-muted-foreground">
            {t("resources.memory.threshold")}
          </dt>
          <dd className="m-0 text-right">{formatMetricBytes(threshold)}</dd>
        </dl>
        <p className="text-muted-foreground">
          {t("resources.session.memoryEstimated")}
        </p>
        {!known && <p role="status">{t("resources.memory.unknownNote")}</p>}
        {over && <p>{t("resources.memory.overNote")}</p>}
        {!watched && (
          <p className="text-muted-foreground">
            {t("resources.memory.slowNote")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
