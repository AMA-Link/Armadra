import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { formatClock } from "@/lib/format";
import { formatTokens } from "@/lib/cost";
import type { SubagentCardModel } from "@/agent/subagent-store";
import { IconButton } from "@/ui/icon-button";
import { StatusPill } from "@/ui/status-pill";

export interface SubagentCardProps {
  card: SubagentCardModel;
  /** 固定「此刻」（毫秒）：计时不再走秒。展示页与测试用，让画面静止。 */
  now?: number;
}

/**
 * 子代理临时卡片（§3.4 / §5.9）。一行 28：左侧 2px 陶土竖条 + 状态胶囊 + 任务名 +
 * 计时 + 「1.2K · 3 次」+ ▸ 展开。只展示状态信息。
 *
 * 数据来自 `agent/subagent-store`（`agent.subagent` 事件），既不入库也不进
 * 撤销。转录尾部不在事件里，所以展开显示的是子代理返回的 `result`——
 * 没有 `result` 就直说没有，而不是留一块空白。
 */
export function SubagentCard({ card, now: fixedNow }: SubagentCardProps) {
  const t = useT();
  const working = card.state === "working";
  const [tick, setNow] = React.useState(() => Date.now());
  const now = fixedNow ?? tick;
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!working || fixedNow !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [working, fixedNow]);

  // 结束之后用回报的时长；还在跑就自己数秒。
  const elapsed = working
    ? Math.max(0, now - card.startedAt)
    : (card.durationMs ?? Math.max(0, now - card.startedAt));

  // tokens 与工具次数合成一枚等宽小字，哪个没有就只写另一个。
  const usage = [
    typeof card.tokens === "number" ? formatTokens(card.tokens) : null,
    typeof card.toolUses === "number"
      ? t("subagent.toolCount", { count: card.toolUses })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div
      data-slot="subagent-card"
      aria-label={t("subagent.card")}
      className="flex w-full flex-col overflow-hidden rounded-card border border-l-2 border-border bg-card shadow-node"
      style={{ borderLeftColor: "var(--agent-working)" }}
    >
      <div className="flex h-(--row-h) items-center gap-2 px-2">
        <StatusPill
          tone={working ? "working" : "done"}
          label={t(working ? "subagent.working" : "subagent.done")}
        />
        <span className="min-w-0 truncate text-meta text-foreground">
          {card.taskLabel}
        </span>
        <span
          data-numeric
          className="ml-auto shrink-0 font-mono text-caption text-muted-foreground"
        >
          {formatClock(elapsed)}
        </span>
        {usage !== "" && (
          <span
            data-slot="subagent-usage"
            data-numeric
            className="shrink-0 font-mono text-caption text-muted-foreground"
          >
            {usage}
          </span>
        )}
        {!working && (
          <IconButton
            label={t(open ? "subagent.collapse" : "subagent.expand")}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </IconButton>
        )}
      </div>
      {open && !working && (
        <pre className="max-h-60 overflow-auto border-t border-border bg-raised px-2 py-1.5 font-mono text-meta whitespace-pre-wrap text-muted-foreground">
          {card.result ?? t("subagent.noResult")}
        </pre>
      )}
    </div>
  );
}
