import * as React from "react";
import {
  ArrowLeftRight,
  Bot,
  Brain,
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

import { TOOL_STATUS_TONES } from "@/agent/display";
import { useT } from "@/app/preferences-store";
import { DiffCounts, diffStat } from "@/acp/DiffBlock";
import { mcpToolDisplay } from "@/acp/mcp-tools";
import { basename } from "@/files/file-operations";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Shimmer } from "@/ui/shimmer";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import {
  ENTRY_BODY,
  ENTRY_FRAME,
  ENTRY_NESTED_BODY,
  ENTRY_TRIGGER,
} from "../entry";
import { formatDuration } from "../format";
import { ToolContentView } from "../parts/ToolContentView";
import { ToolInput } from "../parts/ToolInput";
import { memoRow } from "../row-memo";
import { useElapsed } from "../use-elapsed";

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

/** 工具行上最多画几枚文件胶囊，其余折成 `+N`。 */
export const MAX_LOCATIONS = 2;

/** 完成（或失败）那一下的对勾在图标位上停留多久，之后换回按 kind 的图标。 */
export const DONE_FLASH_MS = 800;

/**
 * 标题里是不是已经写了这个文件：标题里有一个以空白、引号、括号隔开的词，等于这个
 * 路径，或是它在目录边界上的后缀（`note.txt`、`src/config.ts`）。只比整词，
 * 所以「读取 ts 文件」不会因为含有 `ts` 就吞掉 `a.ts` 的位置标签；至少两个字符，
 * 「读 a 文件」里的 `a` 也不算。词尾的 `:12` / `:12:3` 行号先剥掉。
 */
export function titleMentionsPath(title: string, path: string): boolean {
  const full = path.replaceAll("\\", "/");
  for (const raw of title.split(/[\s\x22\x27\x60()[\]{}<>,;]+/)) {
    const word = raw
      .replaceAll("\\", "/")
      .replace(/:\d+(?::\d+)?$/, "")
      .replace(/^\.\//, "");
    if (word.length < 2) continue;
    if (full === word || full.endsWith(`/${word}`)) return true;
  }
  return false;
}

function lineSuffix(line: number | null | undefined): string {
  return line ? `:${line}` : "";
}

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
  if (status === "failed") return <Icon className="text-danger-text" />;
  return <Icon className="text-muted-foreground" />;
}

export interface ToolRowProps {
  item: TimelineToolItem;
  /** 子代理内部的调用（挂在它下面，随这一行展开）。 */
  nested?: readonly TimelineToolItem[] | undefined;
  /** 关联这个工具的审批；有它才会调 `renderApproval`。 */
  approval?: TimelineApprovalItem | undefined;
  /**
   * `toolCallId` → 关联的审批，给 `nested` 里的内部调用用（它们的审批也挂在各自
   * 那一行下面）。有内部调用时才传，免得普通行因为它换了引用而重渲染。
   */
  approvals?: ReadonlyMap<string, TimelineApprovalItem> | undefined;
  /** 审批卡的渲染（B7 接 `PermissionCard`）。要稳定的引用。 */
  renderApproval?:
    ((approval: TimelineApprovalItem) => React.ReactNode) | undefined;
  /** 嵌在活动组或子代理里：没有自己的边框。 */
  plain?: boolean | undefined;
  /** 测试用：固定当前时间。 */
  now?: number | undefined;
}

type TerminalContent = Extract<
  TimelineToolItem["content"][number],
  { type: "terminal" }
>;

/** 工具上最后一个终端部件（命令的输出与退出码在它身上）。 */
function lastTerminal(item: TimelineToolItem): TerminalContent | undefined {
  for (let i = item.content.length - 1; i >= 0; i--) {
    const part = item.content[i];
    if (part?.type === "terminal") return part;
  }
  return undefined;
}

/** 标题行右侧的退出码：0 是描边，非零与被终止是危险色。 */
function ExitBadge({ code }: { code: number | null }) {
  const t = useT();
  return (
    <Badge
      data-slot="timeline-tool-exit"
      data-numeric
      variant={code === 0 ? "outline" : "destructive"}
      size="sm"
      className="shrink-0 font-mono"
    >
      {code === null
        ? t("timeline.terminal.killed")
        : t("timeline.terminal.exit", { code })}
    </Badge>
  );
}

/** 标题行右侧的时长：结束了是总时长，运行中从开始实时计时。 */
function Elapsed({
  item,
  running,
  now,
}: {
  item: TimelineToolItem;
  running: boolean;
  now: number | undefined;
}) {
  const live = useElapsed(running, item.startedAt, now);
  const text =
    item.endedAt !== undefined
      ? formatDuration(item.endedAt - item.startedAt)
      : running
        ? live
        : "";
  if (text === "") return null;
  return (
    <span
      data-numeric
      data-slot="timeline-tool-duration"
      className="font-mono text-caption text-muted-foreground"
    >
      {text}
    </span>
  );
}

function ToolRowImpl({
  item,
  nested,
  approvals,
  approval,
  renderApproval,
  plain,
  now,
}: ToolRowProps) {
  const t = useT();
  const pendingApproval =
    approval !== undefined && approval.state === "pending";
  // 内部调用在等人答复时展开：卡片在它们下面，折着就看不到。用户手动开合之后以用户为准。
  const nestedPending =
    nested?.some(
      (child) => approvals?.get(child.toolCallId)?.state === "pending",
    ) === true;
  // MCP 调用按来源（`item.mcp`）换成本地化的名字与图标，不显示 `mcp.<服务器>.<工具>`。
  const mcp = mcpToolDisplay(item.mcp, t);
  const Icon = mcp?.Icon ?? KIND_ICONS[item.toolKind];
  const running = item.status === "in_progress" || item.status === "pending";
  const terminal = lastTerminal(item);
  // 命令：`execute` 类，或带着终端输出的调用。
  const command =
    mcp === null && (item.toolKind === "execute" || terminal !== undefined);
  // 命令在跑时展开看实时输出，结束后收起。用户手动开合之后以用户为准。
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open =
    manual ?? (nestedPending || (command && item.status === "in_progress"));
  const stat = React.useMemo(() => toolDiffStat(item.content), [item.content]);
  const shown = item.locations.slice(0, MAX_LOCATIONS);
  const hidden = item.locations.slice(MAX_LOCATIONS);
  const rest = hidden.length;
  // 命令行：终端部件带了就用它的，没带就用入参里的（Agent 自己跑的命令）。
  const commandLine = terminal?.command ?? item.input?.command;
  // 终端部件会显示命令，入参摘要里不再重复一行。
  const input =
    item.input !== undefined &&
    terminal !== undefined &&
    commandLine !== undefined
      ? { ...item.input, command: undefined }
      : item.input;
  const exitCode = terminal?.exitCode;
  const hasBody =
    input !== undefined ||
    item.content.length > 0 ||
    (nested?.length ?? 0) > 0 ||
    rest > 0;
  // 已完成、进行中不挂状态字：图标位已经说明了；只有等待、失败、取消要读得出来。
  // 被人拒了的调用：审批的结局行已经写了「已拒绝」，工具行不再叠一枚「失败」；
  // 退出码已经写在标题行上的失败也不再叠。
  const rejected =
    approval !== undefined &&
    approval.state === "answered" &&
    approval.options
      .find((option) => option.optionId === approval.answer?.optionId)
      ?.kind.startsWith("reject") === true;
  const statusText =
    item.status === "pending" ||
    (item.status === "failed" && !rejected && exitCode === undefined) ||
    item.status === "cancelled";
  // 标题里已经写了文件的，不再重复文件名；有行号的仍留一枚「:行号」，行号不在标题里。
  const title = mcp?.title ?? item.title;
  const chips = shown.flatMap((location) => {
    const name = basename(location.path) || location.path;
    if (!titleMentionsPath(title, location.path))
      return [{ location, label: `${name}${lineSuffix(location.line)}` }];
    return location.line
      ? [{ location, label: lineSuffix(location.line) }]
      : [];
  });
  return (
    <div
      data-slot="timeline-tool"
      data-status={item.status}
      data-command={command || undefined}
      className="flex min-w-0 flex-col"
    >
      <Collapsible
        open={open}
        onOpenChange={setManual}
        className={plain ? "min-w-0" : ENTRY_FRAME}
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasBody}
            className={cn(
              ENTRY_TRIGGER,
              "group/tool",
              item.status === "completed" &&
                "text-muted-foreground hover:text-foreground",
            )}
          >
            <LeadIcon Icon={Icon} status={item.status} />
            <Shimmer
              active={item.status === "in_progress"}
              className={cn(
                "min-w-0 truncate text-meta",
                command && "font-mono",
              )}
            >
              {title}
            </Shimmer>
            {chips.map(({ location, label }, index) => (
              <span
                key={index}
                title={location.path}
                data-slot="timeline-tool-location"
                className="max-w-32 min-w-0 shrink truncate font-mono text-caption text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {rest > 0 && (
              <span
                title={hidden.map((location) => location.path).join("\n")}
                className="shrink-0 font-mono text-caption text-muted-foreground"
              >
                {t("timeline.tool.more", { count: rest })}
              </span>
            )}
            {stat !== null && (
              <DiffCounts
                additions={stat.additions}
                deletions={stat.deletions}
              />
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
              {exitCode !== undefined && <ExitBadge code={exitCode} />}
              <Elapsed item={item} running={running} now={now} />
              {statusText && (
                <StatusPill
                  tone={TOOL_STATUS_TONES[item.status]}
                  label={t(`timeline.tool.status.${item.status}`)}
                />
              )}
              {hasBody && (
                <ChevronRight
                  aria-hidden
                  data-open={open || undefined}
                  className="text-muted-foreground transition-[rotate] duration-(--dur-fast) data-open:rotate-90"
                />
              )}
            </span>
          </Button>
        </CollapsibleTrigger>
        {hasBody && (
          <CollapsibleContent
            data-slot="timeline-tool-body"
            className="flex min-w-0 flex-col"
          >
            <div className={plain ? ENTRY_NESTED_BODY : ENTRY_BODY}>
              {rest > 0 && (
                <ul
                  data-slot="timeline-tool-locations"
                  className="flex flex-col gap-0.5 font-mono text-caption text-muted-foreground"
                >
                  {hidden.map((location, index) => (
                    <li key={index} className="min-w-0 truncate">
                      {location.path}
                      {location.line ? `:${location.line}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {input !== undefined && <ToolInput input={input} />}
              {item.content.map((content, index) => (
                <ToolContentView
                  key={index}
                  content={
                    content.type === "terminal" &&
                    content.command === undefined &&
                    commandLine !== undefined
                      ? { ...content, command: commandLine }
                      : content
                  }
                  running={running}
                  exitInHeader
                />
              ))}
              {command && terminal === undefined && !running && (
                <span
                  data-slot="timeline-tool-no-output"
                  className="text-caption text-muted-foreground"
                >
                  {t("timeline.terminal.noOutput")}
                </span>
              )}
            </div>
            {(nested?.length ?? 0) > 0 && (
              <div
                data-slot="timeline-tool-nested"
                className="flex min-w-0 flex-col border-t border-border py-0.5"
              >
                {nested?.map((child) => (
                  <ToolRow
                    key={child.id}
                    item={child}
                    approval={approvals?.get(child.toolCallId)}
                    renderApproval={renderApproval}
                    plain
                  />
                ))}
              </div>
            )}
          </CollapsibleContent>
        )}
      </Collapsible>
      {approval !== undefined && renderApproval !== undefined && (
        <div
          data-slot="timeline-tool-approval"
          data-pending={pendingApproval || undefined}
          className={plain ? "px-2.5 pb-1.5" : "pt-1.5"}
        >
          {renderApproval(approval)}
        </div>
      )}
    </div>
  );
}

export const ToolRow = memoRow(ToolRowImpl);
