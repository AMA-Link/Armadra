import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

/**
 * 一行设置：左标签 / 右控件，行高 40（`settings.css` 的 `.settings-row`）。
 *
 * `footnote` 只留给**当下的状态与错误**（校验失败、被拒的原因、指纹、倒计时这类
 * 动态内容），不写静态说明。
 *
 * `onClick` 把**标签那一半**变成按钮并在末尾补一个 `›`（用于「点进子页」的
 * 行）。刻意不把整行做成按钮：这些行右边常常还有自己的按钮，套在
 * 一个按钮里既不合法也点不准。
 */
export function SettingsRow({
  label,
  footnote,
  children,
  onClick,
  className,
}: {
  /** `null` = 只有动作按钮的一行（左对齐，不重复写一遍按钮上的字）。 */
  label: ReactNode | null;
  footnote?: string;
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const text = (
    <span className="flex min-w-0 flex-col gap-0.5 text-left">
      <span className="break-words text-body text-foreground">{label}</span>
      {footnote && (
        <span className="text-caption text-muted-foreground">{footnote}</span>
      )}
    </span>
  );

  return (
    <div
      data-settings-label={typeof label === "string" ? label : undefined}
      className={cn(
        "settings-row flex w-full items-center gap-4 px-4 py-2",
        label === null ? "justify-start" : "justify-between",
        className,
      )}
    >
      {label === null ? null : onClick ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onClick}
          className="-mx-1 h-auto min-w-0 flex-1 justify-between gap-2 px-1 py-1 font-normal whitespace-normal"
        >
          {text}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      ) : (
        text
      )}
      <div className="settings-row-controls flex max-w-full shrink-0 items-center gap-2">
        {children}
      </div>
    </div>
  );
}
