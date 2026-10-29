import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  AcpPermissionOption,
  AcpToolCall,
  AcpToolKind,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import {
  ApprovalActions,
  ApprovalCommand,
  ApprovalRiskBadge,
  ApprovalShell,
  ApprovalText,
  ApprovalTitle,
  AwaitingDriver,
  useApprovalSize,
} from "@/approval/ApprovalShell";
import { basename } from "@/files/file-operations";
import { unifiedLineDiff } from "@/lib/line-diff";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { acpApi } from "./api";
import { DiffBlock, DiffCounts, patchStat } from "./DiffBlock";
import { useAnsweredStore } from "./answered";
import type { AcpPermissionView } from "./approval-views";

/** 详情里的入参最多先显示这么多行。 */
export const PERMISSION_INPUT_LINES = 20;

/** 「将发生」行最多先画几处文件，其余折成 `+N`。 */
export const PERMISSION_CHANGES_SHOWN = 3;

/** 这几类动作带「有风险」徽标（设计系统 §5.1）。 */
const RISKY_KINDS: ReadonlySet<AcpToolKind | undefined> = new Set<
  AcpToolKind | undefined
>(["execute", "delete", "move"]);

export function isRiskyKind(kind: AcpToolKind | undefined): boolean {
  return RISKY_KINDS.has(kind);
}

function inputPreview(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const lines = text.split("\n");
  return lines.length > PERMISSION_INPUT_LINES
    ? `${lines.slice(0, PERMISSION_INPUT_LINES).join("\n")}\n…`
    : text;
}

interface Change {
  readonly path: string;
  readonly line?: number | null | undefined;
  readonly stat?: { additions: number; deletions: number } | undefined;
}

/**
 * 「将发生」的条目：差异按文件算 `+N −M`，没有差异的涉及文件（`locations`）只列名字。
 * 同一路径只出现一次。
 */
export function changesOf(call: AcpToolCall): Change[] {
  const out: Change[] = [];
  const seen = new Set<string>();
  for (const item of call.content ?? []) {
    if (item.type !== "diff" || seen.has(item.path)) continue;
    seen.add(item.path);
    out.push({
      path: item.path,
      stat: patchStat(unifiedLineDiff(item.oldText ?? "", item.newText)),
    });
  }
  for (const location of call.locations ?? []) {
    if (seen.has(location.path)) continue;
    seen.add(location.path);
    out.push({ path: location.path, line: location.line });
  }
  return out;
}

/** 「将发生」行：文件胶囊（等宽，带 `+N −M`），最多 3 枚，其余 `+N`。 */
function WillHappen({ call }: { call: AcpToolCall }) {
  const t = useT();
  const changes = changesOf(call);
  if (changes.length === 0) return null;
  const shown = changes.slice(0, PERMISSION_CHANGES_SHOWN);
  const rest = changes.length - shown.length;
  return (
    <div
      data-slot="approval-changes"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {shown.map((change) => (
        <Badge
          key={change.path}
          variant="outline"
          size="sm"
          title={change.path}
          className="max-w-full min-w-0 gap-1.5 font-mono"
        >
          <span className="truncate">
            {basename(change.path) || change.path}
            {change.line ? `:${change.line}` : ""}
          </span>
          {change.stat !== undefined && (
            <DiffCounts
              additions={change.stat.additions}
              deletions={change.stat.deletions}
            />
          )}
        </Badge>
      ))}
      {rest > 0 && (
        <Badge variant="outline" size="sm">
          {t("timeline.tool.more", { count: rest })}
        </Badge>
      )}
    </div>
  );
}

/**
 * 「详情」：这次要改什么——`toolCall.content` 的差异预览与入参（前 20 行）。
 * 什么都没有时不出这一行。
 */
function Details({ permission }: { permission: AcpPermissionView }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const call = permission.toolCall;
  const diffs = (call.content ?? []).filter((item) => item.type === "diff");
  const input = inputPreview(call.rawInput);
  if (diffs.length === 0 && !input) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="-ml-1.5 self-start font-normal text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {t("acp.permission.details")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 pt-1">
        {diffs.map((diff, index) =>
          diff.type === "diff" ? (
            <DiffBlock
              key={`${diff.path}-${index}`}
              path={diff.path}
              oldText={diff.oldText ?? ""}
              newText={diff.newText}
            />
          ) : null,
        )}
        {input && (
          <pre className="max-h-60 overflow-auto rounded-control bg-sunken px-2 py-1 font-mono text-meta whitespace-pre">
            {input}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 同意类里「本次」排在「始终」前：Agent 给的顺序不可信（有的把「始终允许」
 * 放第一个），而焦点与 Enter 落在第一枚，不能让一下回车变成永久授权。
 */
const OPTION_RANK: Record<AcpPermissionOption["kind"], number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

export function isAllowOption(option: AcpPermissionOption): boolean {
  return option.kind.startsWith("allow");
}

/** 选项按 允许一次 / 始终允许 / 拒绝 / 始终拒绝 排好；同类保持 Agent 给的先后。 */
export function sortedOptions(
  options: readonly AcpPermissionOption[],
): AcpPermissionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        OPTION_RANK[a.option.kind] - OPTION_RANK[b.option.kind] ||
        a.index - b.index,
    )
    .map(({ option }) => option);
}

export type PermissionScope = "once" | "always";

/**
 * 分段「本次 ｜ 始终」把四种 kind 折成两组按钮：本次 = `allow_once` / `reject_once`，
 * 始终 = `allow_always` / `reject_always`。某一侧缺了就退到另一侧的同向选项（只有
 * `allow_once` 的 Agent，「始终」下的拒绝仍是 `reject_once`）。没有「本次」与「始终」
 * 两个同意选项时不画分段。
 */
export function pairOf(
  options: readonly AcpPermissionOption[],
  scope: PermissionScope,
): {
  allow: AcpPermissionOption | undefined;
  reject: AcpPermissionOption | undefined;
} {
  const byKind = (kind: AcpPermissionOption["kind"]) =>
    options.find((option) => option.kind === kind);
  return scope === "always"
    ? {
        allow: byKind("allow_always") ?? byKind("allow_once"),
        reject: byKind("reject_always") ?? byKind("reject_once"),
      }
    : {
        allow: byKind("allow_once") ?? byKind("allow_always"),
        reject: byKind("reject_once") ?? byKind("reject_always"),
      };
}

/**
 * 答一次：先收起（会话视图的卡片与头部的允许 / 拒绝一起），再发请求——与
 * 头部直答同一个做法，下一条事件未必立刻到，不能让人对着答过的请求再点。
 */
export function answerPermission(
  permission: AcpPermissionView,
  option: AcpPermissionOption,
): Promise<unknown> {
  useAnsweredStore.getState().mark(permission.pendingId);
  useAgentStatusStore.getState().resolveApproval(permission.pendingId);
  return acpApi
    .answer(
      permission.pendingId,
      isAllowOption(option) ? "allow" : "deny",
      option.optionId,
    )
    .catch(() => undefined);
}

/** 标题里要读的那段命令：`execute` 类（或入参里有 `command`）按命令画。 */
function commandOf(permission: AcpPermissionView): string | null {
  const call = permission.toolCall;
  const raw = call.rawInput;
  const command =
    raw !== null && typeof raw === "object"
      ? (raw as { command?: unknown }).command
      : undefined;
  if (call.kind === "execute")
    return call.title || (typeof command === "string" ? command : null);
  return null;
}

/**
 * `session/request_permission` 的卡片（设计系统 §5.1）：标题是工具调用（命令用
 * 等宽、最多 3 行、点开展开，右侧「有风险」只在 execute / delete / move 上出现），
 * 「将发生」列出涉及的文件与 `+N −M`，选项折成分段「本次 ｜ 始终」加两枚按钮：
 * 「拒绝 Esc」与「允许 ↵」（拿焦点）。数字键 1–9 仍按 kind 顺序直答（焦点在卡片里
 * 时）。没有答复权限的人（不是 driver、终端也不是自己起的，契约 §23）看到同一张卡，
 * 按钮换成「等待接管」（设计系统 §5.8）。
 */
export function PermissionCard({
  permission,
  canAnswer,
  className,
  pinned = false,
  onAnswered,
}: {
  permission: AcpPermissionView;
  canAnswer: boolean;
  className?: string;
  /**
   * 钉在输入框上方的那一张：出现时焦点落到「允许」（ACP 会话视图 §5.7）。
   * Esc 拒绝（只在焦点落在卡片里时）。
   */
  pinned?: boolean;
  /** 答完之后（焦点还在卡片里时）调用：把焦点交还输入框，别让它掉到 body。 */
  onAnswered?: () => void;
}) {
  const t = useT();
  const size = useApprovalSize();
  const titleId = React.useId();
  const options = sortedOptions(permission.options);
  const segmented =
    options.some((option) => option.kind === "allow_once") &&
    options.some((option) => option.kind === "allow_always");
  const [scope, setScope] = React.useState<PermissionScope>(
    options.some((option) => option.kind === "allow_once") ||
      !options.some((option) => option.kind === "allow_always")
      ? "once"
      : "always",
  );
  const { allow, reject } = pairOf(options, segmented ? scope : "once");
  const cardRef = React.useRef<HTMLDivElement>(null);
  const allowRef = React.useRef<HTMLButtonElement>(null);
  // 钉住时焦点落到「允许」——但人正在输入框里打字时不抢：那一下 Enter
  // 会变成「允许」。
  React.useEffect(() => {
    if (!pinned || !canAnswer) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.closest("input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }
    allowRef.current?.focus({ preventScroll: true });
  }, [pinned, canAnswer, permission.pendingId]);

  const answer = (option: AcpPermissionOption) => {
    const hadFocus = cardRef.current?.contains(document.activeElement) ?? false;
    void answerPermission(permission, option);
    if (hadFocus) onAnswered?.();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!canAnswer) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key === "Escape") {
      // 焦点在卡片里的 Esc 只答这张卡，不再往上走去停止回合。
      event.stopPropagation();
      if (reject !== undefined) {
        event.preventDefault();
        answer(reject);
      }
      return;
    }
    // 分段控件上的 Enter 同样是「允许」；按钮上的 Enter 是浏览器自己的点击。
    if (
      event.key === "Enter" &&
      (event.target as HTMLElement).getAttribute("role") === "tab"
    ) {
      if (allow !== undefined) {
        event.preventDefault();
        answer(allow);
      }
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    const option = options[Number(event.key) - 1];
    if (option === undefined) return;
    event.preventDefault();
    answer(option);
  };

  const command = commandOf(permission);
  const risky = isRiskyKind(permission.toolCall.kind);
  return (
    <ApprovalShell
      ref={cardRef}
      slot="acp-permission"
      pendingId={permission.pendingId}
      titleId={titleId}
      onKeyDown={onKeyDown}
      {...(className === undefined ? {} : { className })}
    >
      <ApprovalTitle
        id={titleId}
        {...(risky ? { badge: <ApprovalRiskBadge /> } : {})}
      >
        {command !== null ? (
          <ApprovalCommand>{command}</ApprovalCommand>
        ) : (
          <ApprovalText>{permission.toolCall.title}</ApprovalText>
        )}
      </ApprovalTitle>
      <WillHappen call={permission.toolCall} />
      <Details permission={permission} />
      {canAnswer ? (
        <ApprovalActions
          leading={
            segmented ? (
              <Tabs
                value={scope}
                onValueChange={(next) => setScope(next as PermissionScope)}
              >
                <TabsList variant="segmented" size="sm">
                  <TabsTrigger value="once">
                    {t("acp.permission.once")}
                  </TabsTrigger>
                  <TabsTrigger value="always">
                    {t("acp.permission.always")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null
          }
          trailing={
            <>
              {reject !== undefined && (
                <Button
                  size={size}
                  variant={
                    reject.kind === "reject_always" ? "destructive" : "outline"
                  }
                  shortcut="Esc"
                  data-option={reject.kind}
                  onClick={() => answer(reject)}
                >
                  {t("acp.permission.reject")}
                </Button>
              )}
              {allow !== undefined && (
                <Button
                  ref={allowRef}
                  size={size}
                  shortcut="↵"
                  data-option={allow.kind}
                  onClick={() => answer(allow)}
                >
                  {t(
                    allow.kind === "allow_always" && !segmented
                      ? "acp.permission.allowAlways"
                      : "acp.permission.allow",
                  )}
                </Button>
              )}
            </>
          }
        />
      ) : (
        <AwaitingDriver />
      )}
    </ApprovalShell>
  );
}
