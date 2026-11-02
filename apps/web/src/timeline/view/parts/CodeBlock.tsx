import * as React from "react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { ActionBar, CopyAction } from "@/acp/MessageActions";
import { Button } from "@/ui/button";

/** 文本输出最多先露这么多行，其余点「展开全部」（设计系统 §5.1）。 */
export const CODE_BLOCK_LINES = 20;

/**
 * 代码块：等宽 12px，右上角一个「复制」。Markdown 的 `pre` 与工具文本输出共用。
 * 子节点是纯文本且超过 {@link CODE_BLOCK_LINES} 行时先只露前 20 行。
 */
export function CodeBlock({
  className,
  children,
  ...props
}: React.ComponentProps<"pre">) {
  const t = useT();
  const ref = React.useRef<HTMLPreElement>(null);
  const [all, setAll] = React.useState(false);
  const lines = typeof children === "string" ? children.split("\n") : null;
  const folded = lines !== null && !all && lines.length > CODE_BLOCK_LINES;
  return (
    <div className="group/act" data-slot="timeline-code">
      {/* 复制钮在代码右侧自己的一列里，不压在代码上：长行滚动时也不会钻到钮底下。 */}
      <div className="flex items-start rounded-field bg-sunken">
        <pre
          ref={ref}
          className={cn(
            "min-w-0 flex-1 overflow-x-auto py-2 pr-1 pl-2.5 font-mono text-meta",
            className,
          )}
          {...props}
        >
          {folded ? lines.slice(0, CODE_BLOCK_LINES).join("\n") : children}
        </pre>
        <ActionBar className="m-1 shrink-0 rounded-control bg-raised">
          <CopyAction
            text={() =>
              typeof children === "string"
                ? children
                : (ref.current?.textContent ?? "")
            }
          />
        </ActionBar>
      </div>
      {folded && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-0.5"
          onClick={() => setAll(true)}
        >
          {t("acp.tool.showAll")}
        </Button>
      )}
    </div>
  );
}
