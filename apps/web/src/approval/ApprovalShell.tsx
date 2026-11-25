import * as React from "react";
import { Check, ShieldAlert, X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/**
 * 审批与提问共用的一套展示：ACP 会话的权限卡、elicitation 卡、只读转录里的
 * 同一张卡，以及节点头部的允许 / 拒绝都从这里取外壳、按钮行与徽标，样式只此一份。
 */

/**
 * 卡片外壳（设计系统 §5.1）：1px `--warn` 40% 的边（不用单边色条，圆角处会被削成弧），
 * 内边距 10px 配 6px 的控件圆角，外圆角取 `rounded-float`（16 = 6 + 10，同心）。
 * `role="group"` + `aria-labelledby` 让读屏念出「这是在问什么」。
 */
export const ApprovalShell = React.forwardRef<
  HTMLDivElement,
  {
    slot: "acp-permission" | "acp-elicitation";
    pendingId: string;
    /** 标题元素的 id，外壳用它给整张卡命名。 */
    titleId: string;
    className?: string;
    /** 卡片里冒泡上来的按键（审批卡的 ↵ / Esc / 数字直答）。 */
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    children: React.ReactNode;
  }
>(function ApprovalShell(
  { slot, pendingId, titleId, className, onKeyDown, children },
  ref,
) {
  return (
    <Card
      ref={ref}
      role="group"
      aria-labelledby={titleId}
      data-slot={slot}
      data-pending-id={pendingId}
      onKeyDown={onKeyDown}
      className={cn("gap-2 rounded-float border-warn/40 p-2.5", className)}
    >
      {children}
    </Card>
  );
});

/** 标题行：警示图标 + 一段正文（命令走 `ApprovalCommand`）+ 右侧徽标（风险）。 */
export function ApprovalTitle({
  id,
  children,
  badge,
}: {
  id: string;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <ShieldAlert
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-warn-text"
      />
      <div id={id} className="min-w-0 flex-1">
        {children}
      </div>
      {badge}
    </div>
  );
}

/** 「有风险」：只在 `execute / delete / move` 三类动作上出现。 */
export function ApprovalRiskBadge() {
  const t = useT();
  return (
    <Badge variant="warn" size="sm" data-slot="approval-risk">
      {t("acp.permission.risky")}
    </Badge>
  );
}

/** 标题是文字：13px 中等字重，长词与路径任意处折行。 */
export function ApprovalText({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-body font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">
      {children}
    </span>
  );
}

/** 命令行的最多先露这几行；点一下展开全部。 */
export const COMMAND_LINES = 3;

/**
 * 标题是命令：等宽、最多 3 行、点一下展开（`aria-expanded`）。命令是这张卡
 * 唯一要人读懂的东西，不能被截成一行省略号，也不能把整个节点撑满。
 */
export function ApprovalCommand({ children }: { children: string }) {
  const [open, setOpen] = React.useState(false);
  const lines = children.split("\n").length;
  const long = lines > COMMAND_LINES || children.length > 160;
  const text = (
    <code
      className={cn(
        "block min-w-0 flex-1 font-mono text-meta font-normal whitespace-pre-wrap [overflow-wrap:anywhere]",
        !open && "line-clamp-3",
      )}
    >
      {children}
    </code>
  );
  if (!long) return text;
  return (
    <Button
      type="button"
      variant="ghost"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      className="h-auto w-full min-w-0 justify-start rounded-control p-0 text-left font-normal whitespace-normal"
    >
      {text}
    </Button>
  );
}

/**
 * 按钮行：主操作与同意类在前，拒绝类靠末端——「同意」和「拒绝」之间至少隔开
 * 一个行距，不会手滑点到对面；窄了整组换行。
 */
export function ApprovalActions({
  leading,
  trailing,
}: {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      data-slot="approval-actions"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      {leading ? (
        <div className="flex flex-wrap items-center gap-2">{leading}</div>
      ) : null}
      {trailing ? (
        <div className="flex flex-wrap items-center gap-2">{trailing}</div>
      ) : null}
    </div>
  );
}

/**
 * 审批按钮的尺寸：桌面 32（`default`），手机焦点页放到 44（`touch`）——
 * 24–28px 的钮在手机上点不准（设计系统 §2.13）。
 */
export function useApprovalSize(): "default" | "touch" {
  return useCompactLayout() ? "touch" : "default";
}

/** 没有答复权限的人看到的同一张卡：按钮换成这枚徽标（设计系统 §5.8）。 */
export function AwaitingDriver() {
  const t = useT();
  return (
    <Badge variant="outline" className="self-start">
      {t("acp.permission.awaitingDriver")}
    </Badge>
  );
}

/**
 * 节点头部的允许 / 拒绝。图标带色、文字用正文色（绿 / 红的字压在卡面上对比度
 * 不够，而且颜色不该是唯一的线索）；词与卡片一致：允许 / 拒绝。
 */
export function HeaderApproval({
  onAnswer,
}: {
  onAnswer: (decision: "allow" | "deny") => void;
}) {
  const t = useT();
  return (
    <span
      data-slot="header-approval"
      className="node-header-approval flex shrink-0 items-center gap-0.5"
    >
      <Button
        size="xs"
        variant="ghost"
        aria-label={t("node.allow")}
        onClick={() => onAnswer("allow")}
      >
        <Check className="text-success-text" aria-hidden />
        <span>{t("node.allow")}</span>
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-label={t("node.deny")}
        onClick={() => onAnswer("deny")}
      >
        <X className="text-danger-text" aria-hidden />
        <span>{t("node.deny")}</span>
      </Button>
    </span>
  );
}
