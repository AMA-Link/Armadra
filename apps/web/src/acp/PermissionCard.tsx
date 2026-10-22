import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AcpPermissionOption } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import { cn } from "@/lib/cn";
import {
  APPROVAL_BUTTON,
  ApprovalActions,
  ApprovalShell,
  ApprovalCommand,
  ApprovalText,
  ApprovalTitle,
  AwaitingDriver,
} from "@/approval/ApprovalShell";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { acpApi } from "./api";
import { DiffBlock } from "./DiffBlock";
import { useAnsweredStore } from "./answered";
import type { AcpPermissionView } from "./approval-views";

/** 详情里的入参最多先显示这么多行。 */
export const PERMISSION_INPUT_LINES = 20;

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

/**
 * 「详情」：这次要改什么——`toolCall.content` 的差异预览、入参（前 20 行）、
 * 涉及的文件。什么都没有时不出这一行。
 */
function Details({ permission }: { permission: AcpPermissionView }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const call = permission.toolCall;
  const diffs = (call.content ?? []).filter((item) => item.type === "diff");
  const input = inputPreview(call.rawInput);
  const locations = call.locations ?? [];
  if (diffs.length === 0 && !input && locations.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="-ml-1.5 self-start font-normal text-muted-foreground pointer-coarse:h-9"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {t("acp.permission.details")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 pt-1">
        {locations.length > 0 && (
          <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
            {locations.map((location, index) => (
              <li key={index} className="truncate" title={location.path}>
                {location.line
                  ? `${location.path}:${location.line}`
                  : location.path}
              </li>
            ))}
          </ul>
        )}
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
          <pre className="max-h-60 overflow-auto rounded-[var(--r-control)] bg-[var(--surface-raised)] px-2 py-1 font-mono text-xs whitespace-pre">
            {input}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

const OPTION_LABELS: Record<AcpPermissionOption["kind"], string> = {
  allow_once: "acp.permission.allowOnce",
  allow_always: "acp.permission.allowAlways",
  reject_once: "acp.permission.reject",
  reject_always: "acp.permission.rejectAlways",
};

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

const OPTION_VARIANT: Record<
  AcpPermissionOption["kind"],
  "default" | "outline" | "destructive"
> = {
  allow_once: "default",
  allow_always: "outline",
  reject_once: "outline",
  reject_always: "destructive",
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
 * 等宽、最多 3 行、点开展开），选项按 ACP 的 kind 排成「本次允许 · 始终允许 ｜
 * 拒绝」，只有「本次允许」是主按钮。数字键 1–9 按顺序直答（焦点在卡片里时）。
 * 没有答复权限的人（不是 driver、终端也不是自己起的，契约 §23）看到同一张卡，
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
   * 钉在输入框上方的那一张：出现时焦点落到「本次允许」（ACP 会话视图
   * §5.7）。Esc 不答、不关。
   */
  pinned?: boolean;
  /** 答完之后（焦点还在卡片里时）调用：把焦点交还输入框，别让它掉到 body。 */
  onAnswered?: () => void;
}) {
  const t = useT();
  const titleId = React.useId();
  const options = sortedOptions(permission.options);
  const allow = options.filter(isAllowOption);
  const reject = options.filter((option) => !isAllowOption(option));
  const first = allow[0]?.optionId;
  const cardRef = React.useRef<HTMLDivElement>(null);
  const firstRef = React.useRef<HTMLButtonElement>(null);
  // 钉住时焦点落到「本次允许」——但人正在输入框里打字时不抢：那一下 Enter
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
    firstRef.current?.focus({ preventScroll: true });
  }, [pinned, canAnswer, permission.pendingId]);

  const answer = (option: AcpPermissionOption) => {
    const hadFocus = cardRef.current?.contains(document.activeElement) ?? false;
    void answerPermission(permission, option);
    if (hadFocus) onAnswered?.();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (!/^[1-9]$/.test(event.key)) return;
    const option = options[Number(event.key) - 1];
    if (option === undefined) return;
    event.preventDefault();
    answer(option);
  };
  const button = (option: AcpPermissionOption) => (
    <Button
      key={option.optionId}
      size="sm"
      variant={
        option.optionId === first ? "default" : OPTION_VARIANT[option.kind]
      }
      className={APPROVAL_BUTTON}
      ref={option.optionId === first ? firstRef : undefined}
      aria-keyshortcuts={String(options.indexOf(option) + 1)}
      {...(option.name ? { title: option.name } : {})}
      onKeyDown={onKeyDown}
      onClick={() => answer(option)}
    >
      {t(OPTION_LABELS[option.kind])}
    </Button>
  );

  const command = commandOf(permission);
  return (
    <ApprovalShell
      ref={cardRef}
      slot="acp-permission"
      pendingId={permission.pendingId}
      titleId={titleId}
      {...(className === undefined ? {} : { className })}
    >
      <ApprovalTitle id={titleId}>
        {command !== null ? (
          <ApprovalCommand>{command}</ApprovalCommand>
        ) : (
          <ApprovalText>{permission.toolCall.title}</ApprovalText>
        )}
      </ApprovalTitle>
      <Details permission={permission} />
      {canAnswer ? (
        <ApprovalActions
          leading={allow.map(button)}
          trailing={reject.length > 0 ? reject.map(button) : null}
        />
      ) : (
        <AwaitingDriver />
      )}
    </ApprovalShell>
  );
}
