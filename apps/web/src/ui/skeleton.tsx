import { cn } from "cn";

/**
 * 占位条。脉冲只是装饰：`prefers-reduced-motion` 下停掉（`motion-reduce`），
 * 形状与尺寸由调用方按真实内容给出——换成真内容时不得跳动。
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-muted motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
