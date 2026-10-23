import { Skeleton } from "@/ui/skeleton";

/**
 * 中转登录表单的占位：账号、口令两个触控输入（44，同 `RelayForm`）加一枚整宽按钮。
 * 续登录期间与入口未判定时用，内容出来时页面不动。
 */
export function RelayFormSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="relay-form-skeleton"
      className="flex flex-col gap-(--space-block)"
    >
      {[0, 1].map((index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-[44px] w-full" />
        </div>
      ))}
      <Skeleton className="h-[44px] w-full" />
    </div>
  );
}
