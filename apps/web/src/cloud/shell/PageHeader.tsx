import type { ReactNode } from "react";

/** 页头：`<h1>` 17/600，右端最多一个主动作（云端控制台 §2.1）。 */
export function PageHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex min-h-8 items-center justify-between gap-3 pb-6">
      <h1 className="min-w-0 text-title leading-6 font-semibold text-balance">
        {title}
      </h1>
      {action}
    </header>
  );
}
