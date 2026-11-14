import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { when } from "./forge-keys";
import {
  ForgeStateBadge,
  ForgeStateIcon,
  type ForgeItemKind,
  type ForgeItemState,
} from "./ForgeStateBadge";

export interface ForgeItemRowItem {
  number: number;
  title: string;
  state: ForgeItemState;
  draft?: boolean;
  author: string | null;
  updatedAtMs: number;
  labels?: readonly string[];
}

/**
 * 一条 issue / PR 的一行：状态图标、`#n`、标题、状态胶囊，下面作者、时间与标签。
 * 面板列表与画布徽标的悬浮卡是同一个组件；没有 `onOpen` 时是静态的一块。
 */
export function ForgeItemRow({
  kind,
  item,
  locale,
  onOpen,
}: {
  kind: ForgeItemKind;
  item: ForgeItemRowItem;
  locale: string;
  onOpen?: () => void;
}) {
  const meta = [item.author, when(item.updatedAtMs, locale)]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <ForgeStateIcon kind={kind} state={item.state} draft={item.draft} />
        <span className="shrink-0 tabular-nums text-muted-foreground">
          #{item.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-body font-medium">
          {item.title}
        </span>
        <ForgeStateBadge state={item.state} draft={item.draft} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-meta font-normal text-muted-foreground">
        <span className="min-w-0 truncate">{meta}</span>
        {(item.labels ?? []).slice(0, 3).map((label) => (
          <Badge key={label} variant="outline" size="sm" className="max-w-24">
            <span className="truncate">{label}</span>
          </Badge>
        ))}
      </span>
    </>
  );
  return (
    <article
      data-slot={`forge-${kind}`}
      data-number={item.number}
      className="min-w-0 rounded-card border border-border"
    >
      {onOpen ? (
        <Button
          variant="ghost"
          className="h-auto w-full min-w-0 flex-col items-stretch gap-1 px-3 py-2 text-left"
          onClick={onOpen}
        >
          {body}
        </Button>
      ) : (
        <div className="flex min-w-0 flex-col gap-1 px-3 py-2">{body}</div>
      )}
    </article>
  );
}
