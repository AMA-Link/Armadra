import { cn } from "@/lib/cn";
import { Loader2Icon } from "lucide-react";

export type SpinnerState = "spinning" | "done" | "failed";

/**
 * 转圈（设计系统 §8.5）。一圈 0.8s 线性；尺寸只有 12 / 16 两档。
 * `state="done"` 收成对勾（路径画出 240ms），`"failed"` 收成 ×；按钮的 `loading`
 * 结束时用它给 800ms 的完成反馈。
 *
 * 不写死读屏名字：调用方传 `aria-label`（此时是 `role="status"`），没传就当装饰
 * 图标藏起来，按钮自己的文字已经说明了在做什么。减少动效下保留转圈（唯一必要的循环）。
 */
function Spinner({
  className,
  size = 16,
  state = "spinning",
  ...props
}: Omit<React.ComponentProps<"svg">, "ref"> & {
  size?: 12 | 16;
  state?: SpinnerState;
}) {
  const named =
    props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  const sizeClass = size === 12 ? "size-3" : "size-4";
  const a11y = named ? { role: "status" } : { "aria-hidden": true };

  if (state === "spinning") {
    return (
      <Loader2Icon
        data-slot="spinner"
        data-state="spinning"
        {...a11y}
        className={cn(sizeClass, "anim-spin", className)}
        {...props}
      />
    );
  }

  return (
    <svg
      data-slot="spinner"
      data-state={state}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
      className={cn("lucide shrink-0", sizeClass, className)}
      {...props}
    >
      {state === "done" ? (
        <path
          className="anim-check-draw"
          pathLength={1}
          d="M5 12.5l4.5 4.5L19 7.5"
        />
      ) : (
        <path d="M6 6l12 12M18 6L6 18" />
      )}
    </svg>
  );
}

export { Spinner };
