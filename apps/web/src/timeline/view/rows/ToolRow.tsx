import * as React from "react";
import {
  ArrowLeftRight,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  MoveRight,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  TimelineApprovalItem,
  TimelineToolItem,
  TimelineToolKind,
  TimelineToolStatus,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { basename } from "@/files/file-operations";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { formatDuration } from "../format";
import { ToolContentView } from "../parts/ToolContentView";
import { ToolInput } from "../parts/ToolInput";
import { memoRow } from "../row-memo";

export const KIND_ICONS: Record<TimelineToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ArrowLeftRight,
  other: Wrench,
  subagent: Bot,
};

export const STATUS_TONES: Record<TimelineToolStatus, StatusTone> = {
  pending: "queued",
  in_progress: "working",
  completed: "done",
  failed: "failed",
  cancelled: "paused",
};

/** 工具行上最多画几枚文件胶囊，其余折成 `+N`。 */
export const MAX_LOCATIONS = 2;

export interface ToolRowProps {
  item: TimelineToolItem;
  /** 子代理内部的调用（挂在它下面，随这一行展开）。 */
  nested?: readonly TimelineToolItem[] | undefined;
  /** 关联这个工具的审批；有它才会调 `renderApproval`。 */
  approval?: TimelineApprovalItem | undefined;
  /** 审批卡的渲染（B7 接 `PermissionCard`）。要稳定的引用。 */
  renderApproval?:
    | ((approval: TimelineApprovalItem) => React.ReactNode)
    | undefined;
}

function ToolRowImpl({ item, nested, approval, renderApproval }: ToolRowProps) {
  const t = useT();
  const pendingApproval =
    approval !== undefined && approval.state === "pending";
  const [open, setOpen] = React.useState(false);
  const Icon = KIND_ICONS[item.toolKind];
  const running = item.status === "in_progress" || item.status === "pending";
  const shown = item.locations.slice(0, MAX_LOCATIONS);
  const rest = item.locations.length - shown.length;
  const duration =
    item.endedAt !== undefined
      ? formatDuration(item.endedAt - item.startedAt)
      : "";
  const hasBody =
    item.input !== undefined ||
    item.content.length > 0 ||
    (nested?.length ?? 0) > 0;
  return (
    <div
      data-slot="timeline-tool"
      data-status={item.status}
      className="min-w-0"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasBody}
            className="h-7 w-full min-w-0 justify-start gap-1.5 px-2 font-normal disabled:opacity-100"
          >
            {open ? (
              <ChevronDown className="text-muted-foreground" />
            ) : (
              <ChevronRight className="text-muted-foreground" />
            )}
            <Icon className="text-muted-foreground" />
            <span className="min-w-0 truncate text-xs">{item.title}</span>
            {shown.map((location, index) => (
              <Badge
                key={index}
                variant="outline"
                title={location.path}
                className="max-w-28 min-w-0 shrink font-mono"
              >
                <span className="truncate">
                  {basename(location.path) || location.path}
                  {location.line ? `:${location.line}` : ""}
                </span>
              </Badge>
            ))}
            {rest > 0 && (
              <Badge variant="outline" className="shrink-0 tabular-nums">
                {t("timeline.tool.more", { count: rest })}
              </Badge>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {duration !== "" && (
                <span className="text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
                  {duration}
                </span>
              )}
              <StatusPill
                tone={STATUS_TONES[item.status]}
                label={t(`timeline.tool.status.${item.status}`)}
              />
            </span>
          </Button>
        </CollapsibleTrigger>
        {hasBody && (
          <CollapsibleContent className="flex flex-col gap-1.5 py-1 pr-1 pl-7">
            {item.input !== undefined && <ToolInput input={item.input} />}
            {item.content.map((content, index) => (
              <ToolContentView
                key={index}
                content={content}
                running={running}
              />
            ))}
            {nested?.map((child) => (
              <ToolRow key={child.id} item={child} />
            ))}
          </CollapsibleContent>
        )}
      </Collapsible>
      {approval !== undefined && renderApproval !== undefined && (
        <div
          data-slot="timeline-tool-approval"
          data-pending={pendingApproval || undefined}
          className="pt-1 pl-7"
        >
          {renderApproval(approval)}
        </div>
      )}
    </div>
  );
}

export const ToolRow = memoRow(ToolRowImpl);
