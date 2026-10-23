import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";

/**
 * 空与错的统一样式（设计系统 §5.16）：只有一句名词 / 动词短语，不写说明；
 * 错误行内一枚重试，空态可带一个图标。`inline` 是列表 / 树里的紧凑形态。
 */

export function EmptyState({
  title,
  icon,
  inline = false,
  className,
  children,
}: {
  title: string;
  icon?: ReactNode;
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Empty
      data-state-kind="empty"
      className={cn(
        inline
          ? "items-start gap-0 rounded-none border-0 p-0 px-3 py-1.5 text-left"
          : undefined,
        className,
      )}
    >
      <EmptyHeader className={inline ? "items-start" : undefined}>
        {icon && !inline ? (
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
        ) : null}
        <EmptyTitle
          className={
            inline ? "text-meta font-normal text-muted-foreground" : undefined
          }
        >
          {title}
        </EmptyTitle>
      </EmptyHeader>
      {children}
    </Empty>
  );
}

export function ErrorState({
  title,
  retryLabel,
  onRetry,
  inline = false,
  className,
}: {
  title: string;
  retryLabel: string;
  onRetry?: () => void;
  inline?: boolean;
  className?: string;
}) {
  return (
    <Alert
      variant="destructive"
      data-state-kind="error"
      className={cn(
        inline
          ? "flex items-center gap-1 rounded-none border-0 bg-transparent px-3 py-1 text-meta"
          : "self-start",
        className,
      )}
    >
      <AlertTitle
        className={inline ? "min-w-0 flex-1 truncate font-normal" : undefined}
      >
        {title}
      </AlertTitle>
      {onRetry ? (
        inline ? (
          <IconButton label={retryLabel} onClick={onRetry}>
            <RotateCw />
          </IconButton>
        ) : (
          <AlertAction>
            <IconButton label={retryLabel} onClick={onRetry}>
              <RotateCw />
            </IconButton>
          </AlertAction>
        )
      ) : null}
    </Alert>
  );
}
