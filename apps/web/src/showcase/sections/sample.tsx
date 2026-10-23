import type * as React from "react";

/** 一格样本：上面组件，下面组件名（`data-sample` 是探针与测试的锚点）。 */
export function Sample({
  name,
  children,
  wide = false,
}: {
  name: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      data-sample={name}
      className={
        wide
          ? "flex w-full max-w-md flex-col gap-2"
          : "flex flex-col items-start gap-2"
      }
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <span className="font-mono text-caption text-muted-foreground">
        {name}
      </span>
    </div>
  );
}
