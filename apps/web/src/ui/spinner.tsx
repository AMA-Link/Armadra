import { cn } from "cn";
import { Loader2Icon } from "lucide-react";

/**
 * 按钮内的提交态转圈。不写死读屏名字：调用方传 `aria-label`（此时是 `role="status"`），
 * 没传就当装饰图标藏起来，按钮自己的文字已经说明了在做什么。
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const named =
    props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  return (
    <Loader2Icon
      data-slot="spinner"
      {...(named ? { role: "status" } : { "aria-hidden": true })}
      className={cn(
        "size-4 animate-spin motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
