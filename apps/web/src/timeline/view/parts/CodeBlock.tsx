import * as React from "react";

import { cn } from "@/lib/cn";
import { ActionBar, CopyAction } from "@/acp/MessageActions";

/** 代码块：等宽 12px，右上角一个「复制」。Markdown 的 `pre` 与工具文本输出共用。 */
export function CodeBlock({
  className,
  children,
  ...props
}: React.ComponentProps<"pre">) {
  const ref = React.useRef<HTMLPreElement>(null);
  return (
    <div className="group/act relative" data-slot="timeline-code">
      <pre
        ref={ref}
        className={cn(
          "overflow-x-auto rounded-[var(--r-control)] bg-[var(--surface-raised)] px-2 py-1 font-mono text-xs",
          className,
        )}
        {...props}
      >
        {children}
      </pre>
      <ActionBar className="absolute top-1 right-1 rounded-[var(--r-control)] bg-[var(--surface-raised)]">
        <CopyAction text={() => ref.current?.textContent ?? ""} />
      </ActionBar>
    </div>
  );
}
