import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  ActivityEntry,
  ActivitySummary,
  TimelineApprovalItem,
} from "@armadra/shared";

import { useT, type Translate } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { ThoughtRow } from "./rows/ThoughtRow";
import { ToolRow } from "./rows/ToolRow";

export type ActivityGroupEntry = Extract<ActivityEntry, { type: "group" }>;

const SUMMARY_KEYS: ReadonlyArray<readonly [keyof ActivitySummary, string]> = [
  ["reads", "timeline.group.reads"],
  ["edits", "timeline.group.edits"],
  ["commands", "timeline.group.commands"],
  ["searches", "timeline.group.searches"],
  ["fetches", "timeline.group.fetches"],
  ["thoughts", "timeline.group.thoughts"],
  ["others", "timeline.group.others"],
  ["failed", "timeline.group.failed"],
];

/** 「读了 5 个文件 · 改了 2 个 · 运行 1 条命令」：为零的类别不出现。 */
export function summaryLabel(summary: ActivitySummary, t: Translate): string {
  return SUMMARY_KEYS.filter(([field]) => summary[field] > 0)
    .map(([field, key]) => t(key, { count: summary[field] }))
    .join(" · ");
}

export interface ActivityGroupProps {
  entry: ActivityGroupEntry;
  /** `toolCallId` → 关联的审批。 */
  approvals?: ReadonlyMap<string, TimelineApprovalItem> | undefined;
  renderApproval?:
    | ((approval: TimelineApprovalItem) => React.ReactNode)
    | undefined;
}

/**
 * 连续的工具与思考折成一行摘要（设计 §3.1）。进行中保持展开；结束后收起，
 * 点开看明细。用户手动开合之后以用户为准。
 */
export const ActivityGroup = React.memo(function ActivityGroup({
  entry,
  approvals,
  renderApproval,
}: ActivityGroupProps) {
  const t = useT();
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open = manual ?? entry.running;
  return (
    <Collapsible
      open={open}
      onOpenChange={setManual}
      data-slot="timeline-group"
      data-running={entry.running || undefined}
      className="min-w-0"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full min-w-0 justify-start gap-1.5 px-2 font-normal text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <span className="min-w-0 truncate text-meta">
            {summaryLabel(entry.summary, t)}
          </span>
          {entry.running && <Spinner size={12} />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5">
        {entry.items.map((member) =>
          member.kind === "thought" ? (
            <ThoughtRow key={member.id} item={member} />
          ) : (
            <ToolRow
              key={member.id}
              item={member}
              approval={approvals?.get(member.toolCallId)}
              renderApproval={renderApproval}
            />
          ),
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});
