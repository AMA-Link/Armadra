import * as React from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

/**
 * 分页（shadcn Pagination）。页码是按钮而不是链接：设置页与面板里的列表在
 * 内存里翻页，没有地址可去。「上一页 / 下一页」的文字由调用方经 i18n 给。
 */
function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row items-center gap-0.5", className)}
      {...props}
    />
  );
}

function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

type PaginationLinkProps = {
  isActive?: boolean;
} & Pick<React.ComponentProps<typeof Button>, "size"> &
  Omit<React.ComponentProps<"button">, "type">;

function PaginationLink({
  className,
  isActive,
  size = "icon-sm",
  ...props
}: PaginationLinkProps) {
  return (
    <Button
      type="button"
      aria-current={isActive ? "page" : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      variant={isActive ? "outline" : "ghost"}
      size={size}
      className={cn("tabular-nums", className)}
      {...props}
    />
  );
}

function PaginationPrevious({
  className,
  text,
  ...props
}: Omit<PaginationLinkProps, "children"> & { text: string }) {
  return (
    <PaginationLink
      aria-label={text}
      size="sm"
      className={cn("pl-1.5!", className)}
      {...props}
    >
      <ChevronLeftIcon data-icon="inline-start" />
      <span className="hidden sm:block">{text}</span>
    </PaginationLink>
  );
}

function PaginationNext({
  className,
  text,
  ...props
}: Omit<PaginationLinkProps, "children"> & { text: string }) {
  return (
    <PaginationLink
      aria-label={text}
      size="sm"
      className={cn("pr-1.5!", className)}
      {...props}
    >
      <span className="hidden sm:block">{text}</span>
      <ChevronRightIcon data-icon="inline-end" />
    </PaginationLink>
  );
}

function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn(
        "flex size-7 items-center justify-center text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <MoreHorizontalIcon />
    </span>
  );
}

/**
 * 要画出来的页码（从 0 数）：首末两页、当前页和它两边各一页，中间断开处是
 * `"gap"`。页数不多（≤ 7）时全列。
 */
function paginationRange(page: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index);
  const shown = new Set(
    [0, count - 1, page - 1, page, page + 1].filter(
      (index) => index >= 0 && index < count,
    ),
  );
  const sorted = [...shown].sort((a, b) => a - b);
  const range: (number | "gap")[] = [];
  for (const [position, index] of sorted.entries()) {
    const previous = sorted[position - 1];
    if (previous !== undefined && index - previous > 1) range.push("gap");
    range.push(index);
  }
  return range;
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
};
