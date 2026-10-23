import { cn } from "@/lib/cn";

/**
 * 文字微光（设计系统 §8.5）：加载中的按钮标签、思考行标签。遮罩 1.4s 线性扫过，
 * 文字色不变；`active=false` 时原样输出（不换节点，宽度不变）。减少动效下静止。
 */
function Shimmer({
  className,
  active = true,
  ...props
}: React.ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      data-slot="shimmer"
      data-active={active ? "true" : "false"}
      className={cn(active && "anim-shimmer", className)}
      {...props}
    />
  );
}

export { Shimmer };
