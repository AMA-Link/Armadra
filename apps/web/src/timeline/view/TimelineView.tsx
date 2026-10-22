import * as React from "react";
import { ListChecks } from "lucide-react";
import {
  activityGroups,
  type SessionActivity,
  type TimelineApprovalItem,
  type TimelineElicitationItem,
  type TimelineItem,
  type TimelinePlanItem,
  type TimelineToolItem,
  type TimelineTurnItem,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { SkeletonTurns } from "@/ui/skeletons";
import { ActivityGroup } from "./ActivityGroup";
import { ActivityLine } from "./ActivityLine";
import { planProgress, PlanBar } from "./PlanBar";
import { AssistantRow } from "./rows/AssistantRow";
import { NoticeRow } from "./rows/NoticeRow";
import { ThoughtRow } from "./rows/ThoughtRow";
import { ToolRow } from "./rows/ToolRow";
import { TurnFooter } from "./rows/TurnFooter";
import { UserRow } from "./rows/UserRow";
import {
  TimelineServicesProvider,
  type TimelineViewServices,
} from "./services";
import { groupTurns, type TurnBlock } from "./turns";
import { VirtualTurnList } from "./VirtualTurnList";

export interface TurnActions {
  renderApproval?:
    | ((approval: TimelineApprovalItem) => React.ReactNode)
    | undefined;
  renderElicitation?:
    | ((elicitation: TimelineElicitationItem) => React.ReactNode)
    | undefined;
  onRetry?: (() => void) | undefined;
  onContinue?: (() => void) | undefined;
  /** 用户行「编辑后重发」：把这句填回输入框。 */
  onEdit?: ((text: string) => void) | undefined;
  /** 最后一回合助手行「重新生成」：重发这一回合的提问。 */
  onRegenerate?: ((text: string) => void) | undefined;
}

/** 回合内第一次出现计划时插的一行（顶部计划条显示的是最新的一份）。 */
function PlanLine({ plan }: { plan: TimelinePlanItem }) {
  const { done, total, current } = planProgress(plan.entries);
  return (
    <div
      data-slot="timeline-plan-line"
      className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground"
    >
      <ListChecks className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{current?.content}</span>
      <span className="shrink-0 tabular-nums">
        {done} / {total}
      </span>
    </div>
  );
}

/** 一个回合：用户提问、活动组、助手消息、回合尾。 */
export const TurnSection = React.memo(function TurnSection({
  block,
  renderApproval,
  renderElicitation,
  onRetry,
  onContinue,
  onEdit,
  onRegenerate,
  last,
}: { block: TurnBlock; last?: boolean } & TurnActions) {
  const view = React.useMemo(() => {
    const toolIds = new Set<string>();
    for (const item of block.items) {
      if (item.kind === "tool") toolIds.add(item.toolCallId);
    }
    const approvals = new Map<string, TimelineApprovalItem>();
    let footer: TimelineTurnItem | undefined;
    let planSeen = false;
    const flow: TimelineItem[] = [];
    for (const item of block.items) {
      if (item.kind === "turn") {
        footer = item;
      } else if (
        item.kind === "approval" &&
        item.toolCallId !== undefined &&
        toolIds.has(item.toolCallId)
      ) {
        approvals.set(item.toolCallId, item);
      } else if (item.kind === "plan") {
        if (!planSeen) flow.push(item);
        planSeen = true;
      } else {
        flow.push(item);
      }
    }
    const entries = activityGroups(flow);
    let prompt: string | undefined;
    for (const item of block.items) {
      if (item.kind === "user") {
        prompt = item.text;
        break;
      }
    }
    // 重新生成只挂在最后一回合最后一条助手消息上。
    let regenerateId: string | undefined;
    if (last === true && prompt !== undefined && prompt !== "") {
      for (let i = flow.length - 1; i >= 0; i--) {
        const item = flow[i] as TimelineItem;
        if (item.kind === "assistant") {
          regenerateId = item.id;
          break;
        }
      }
    }
    return { entries, approvals, footer, prompt, regenerateId };
  }, [block, last]);

  const toolRow = (
    item: TimelineToolItem,
    nested?: readonly TimelineToolItem[],
  ) => (
    <ToolRow
      key={item.id}
      item={item}
      nested={nested}
      approval={view.approvals.get(item.toolCallId)}
      renderApproval={renderApproval}
    />
  );

  return (
    <section
      data-slot="timeline-turn-section"
      data-turn={block.turn}
      className="flex min-w-0 flex-col gap-1.5 px-3 pb-3"
    >
      {view.entries.map((entry) => {
        if (entry.type === "group") {
          return (
            <ActivityGroup
              key={entry.id}
              entry={entry}
              approvals={view.approvals}
              renderApproval={renderApproval}
            />
          );
        }
        const item = entry.item;
        switch (item.kind) {
          case "user":
            return <UserRow key={item.id} item={item} onEdit={onEdit} />;
          case "assistant":
            return (
              <AssistantRow
                key={item.id}
                item={item}
                prompt={view.prompt}
                onRegenerate={
                  item.id === view.regenerateId ? onRegenerate : undefined
                }
              />
            );
          case "thought":
            return <ThoughtRow key={item.id} item={item} />;
          case "tool":
            return toolRow(item, entry.children);
          case "plan":
            return <PlanLine key={item.id} plan={item} />;
          case "notice":
            return <NoticeRow key={item.id} item={item} />;
          case "approval":
            return renderApproval === undefined ? null : (
              <React.Fragment key={item.id}>
                {renderApproval(item)}
              </React.Fragment>
            );
          case "elicitation":
            return renderElicitation === undefined ? null : (
              <React.Fragment key={item.id}>
                {renderElicitation(item)}
              </React.Fragment>
            );
          case "turn":
            return null;
        }
      })}
      {view.footer !== undefined && (
        <TurnFooter
          item={view.footer}
          onRetry={onRetry}
          onContinue={onContinue}
        />
      )}
    </section>
  );
});

export interface TimelineViewProps extends TurnActions {
  /** 已按显示顺序（回合、序号）排好的条目；B5 的 store 给出。 */
  items: readonly TimelineItem[];
  activity?: SessionActivity | null | undefined;
  /** 还没有任何内容时显示骨架。 */
  loading?: boolean | undefined;
  /** 滚到顶部附近：取更早的回合。 */
  onLoadOlder?: (() => void) | undefined;
  /** 换会话时变，列表回到底部。 */
  resetKey?: string | undefined;
  services?: TimelineViewServices | undefined;
  initialRect?: { width: number; height: number } | undefined;
  className?: string | undefined;
}

function latestPlan(items: readonly TimelineItem[]): TimelinePlanItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as TimelineItem;
    if (item.kind === "plan") return item;
  }
  return null;
}

/**
 * 会话时间线视图（设计 §3、§7）：顶部计划条，中间按回合虚拟化的列表，底部活动行。
 * 全部数据从 props 进，不碰 store 与网络；回调与 `services` 请保持稳定引用，
 * 行组件才能按 `rev` 跳过重渲染。
 */
export function TimelineView({
  items,
  activity,
  loading,
  onLoadOlder,
  resetKey,
  services,
  initialRect,
  className,
  renderApproval,
  renderElicitation,
  onRetry,
  onContinue,
  onEdit,
  onRegenerate,
}: TimelineViewProps) {
  const t = useT();
  const blocks = React.useRef<TurnBlock[]>([]);
  const turns = React.useMemo(() => {
    blocks.current = groupTurns(items, blocks.current);
    return blocks.current;
  }, [items]);
  const plan = React.useMemo(() => latestPlan(items), [items]);
  const lastTurn = turns.at(-1)?.turn;
  const renderTurn = React.useCallback(
    (block: TurnBlock) => (
      <TurnSection
        block={block}
        renderApproval={renderApproval}
        renderElicitation={renderElicitation}
        onRetry={onRetry}
        onContinue={onContinue}
        onEdit={onEdit}
        onRegenerate={onRegenerate}
        last={block.turn === lastTurn}
      />
    ),
    [
      renderApproval,
      renderElicitation,
      onRetry,
      onContinue,
      onEdit,
      onRegenerate,
      lastTurn,
    ],
  );
  const empty = turns.length === 0;
  return (
    <TimelineServicesProvider value={services ?? {}}>
      <div
        data-slot="timeline-view"
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}
      >
        <PlanBar plan={plan} />
        {empty && loading ? (
          <div data-slot="timeline-skeleton" className="flex-1">
            <DeferredSkeleton>
              <SkeletonTurns label={t("state.loading")} />
            </DeferredSkeleton>
          </div>
        ) : (
          <VirtualTurnList
            turns={turns}
            getKey={getTurnKey}
            renderTurn={renderTurn}
            resetKey={resetKey}
            onNearTop={onLoadOlder}
            initialRect={initialRect}
            aria-label={t("timeline.label")}
          />
        )}
        <ActivityLine activity={activity} />
      </div>
    </TimelineServicesProvider>
  );
}

const getTurnKey = (block: TurnBlock): number => block.turn;
