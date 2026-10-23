import * as React from "react";

import { BrandMark } from "@/ui/brand-mark";

/** 公开页的一列（设计系统 §5.9：360 宽、BrandMark 居中、标题在下）。 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex h-full min-h-0 flex-col items-center overflow-y-auto bg-background px-4 py-10"
    >
      <div
        data-slot="cloud-auth"
        className="my-auto flex w-full max-w-[360px] flex-col gap-(--space-section)"
      >
        <div className="flex flex-col items-center gap-3">
          <BrandMark className="size-12" />
          <h1 className="text-center text-display leading-tight font-semibold">
            {title}
          </h1>
          {subtitle !== undefined && (
            <p className="text-center text-body text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {children}
      </div>
    </main>
  );
}
