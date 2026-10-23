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
import { DiffCounts, diffStat } from "@/acp/DiffBlock";
import { basename } from "@/files/file-operations";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Shimmer } from "@/ui/shimmer";
import { Spinner } from "@/ui/spinner";
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

/** 完成（或失败）那一下的对勾在图标位上停留多久，之后换回按 kind 的图标。 */
export const DONE_FLASH_MS = 800;

/** 超过这个长度的差异不在渲染时现算行数（大文件整份替换时拖慢列表）。 */
const STAT_MAX_CHARS = 400_000;

/**
 * 工具行右侧的 `+N −M`：差异内容按文件累加；超限的差异只带行数，直接用。
 * 没有差异内容的工具返回 `null`。
 */
export function toolDiffStat(
  content: readonly TimelineToolItem["content"][number][],
): { additions: number; deletions: number } | null {
  let additions = 0;
  let deletions = 0;
  let any = false;
  for (const part of content) {
    if (part.type !== "diff") continue;
    any = true;
    if (part.truncated) {
      additions += part.addedLines ?? 0;
      deletions += part.removedLines ?? 0;
      continue;
    }
    const before = part.oldText ?? "";
    const after = part.newText ?? "";
    if (before.length + after.length > STAT_MAX_CHARS) continue;
    const stat = diffStat(before, after);
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return any ? { additions, deletions } : null;
}

/**
 * 图标位：运行中是 `Spinner 12`；刚结束那 {@link DONE_FLASH_MS} 毫秒收成对勾 / ×；
 * 其余是按 kind 的图标。第一次渲染时就已结束的行（历史）不闪。
 */
function LeadIcon({
  Icon,
  status,
}: {
  Icon: LucideIcon;
  status: TimelineToolStatus;
}) {
  const last = React.useRef(status);
  const [flash, setFlash] = React.useState<"done" | "failed" | null>(null);
  React.useEffect(() => {
    const before = last.current;
    last.current = status;
    if (before !== "in_progress") return;
    if (status === "completed" || status === "failed") {
      setFlash(status === "completed" ? "done" : "failed");
      const timer = setTimeout(() => setFlash(null), DONE_FLASH_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [status]);
  if (status === "in_progress")
    return <Spinner size={12} className="text-muted-foreground" />;
  if (flash !== null)
    return (
      <Spinner
        size={12}
        state={flash}
        className={flash === "done" ? "text-success-text" : "text-danger-text"}
      />
    );
  return <Icon className="text-muted-foreground" />;
}

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
  const stat = React.useMemo(() => toolDiffStat(item.content), [item.content]);
  const shown = item.locations.slice(0, MAX_LOCATIONS);
  const rest = item.locations.length - shown.length;
  const duration =
    item.endedAt !== undefined
      ? formatDuration(item.endedAt - item.startedAt)
      : "";
  // 终端部件已经显示了命令，入参摘要里不再重复一行。
  const terminalCommand = item.content.some(
    (part) =>
      part.type === "terminal" &&
      part.command !== undefined &&
      part.command === item.input?.command,
  );
  const input =
    item.input !== undefined && terminalCommand
      ? { ...item.input, command: undefined }
      : item.input;
  const hasBody =
    input !== undefined || item.content.length > 0 || (nested?.length ?? 0) > 0;
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
            className="w-full min-w-0 justify-start gap-1.5 px-2 font-normal disabled:opacity-100"
          >
            {open ? (
              <ChevronDown className="text-muted-foreground" />
            ) : (
              <ChevronRight className="text-muted-foreground" />
            )}
            <LeadIcon Icon={Icon} status={item.status} />
            <Shimmer
              active={item.status === "in_progress"}
              className="min-w-0 truncate font-mono text-meta"
            >
              {item.title}
            </Shimmer>
            {shown.map((location, index) => (
              <Badge
                key={index}
                variant="outline"
                size="sm"
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
              <Badge variant="outline" size="sm" className="shrink-0">
                {t("timeline.tool.more", { count: rest })}
              </Badge>
            )}
            {stat !== null && (
              <DiffCounts
                additions={stat.additions}
                deletions={stat.deletions}
              />
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {duration !== "" && (
                <span
                  data-numeric
                  className="font-mono text-caption text-muted-foreground"
                >
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
            {input !== undefined && <ToolInput input={input} />}
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
