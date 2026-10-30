import { useT } from "./preferences-store";
import { useWorkspaceAccessEmpty } from "./use-access-lost";
import { EmptyState } from "@/ui/state";

/**
 * 失去当前工作空间、那个源里又一个都看不到了（#632）：主区正中一句空态。平时没有
 * 工作空间时主区照旧空着、不写提示（§14），只有这一种「被收走」才说。
 */
export function NoWorkspaceAccess() {
  const t = useT();
  const empty = useWorkspaceAccessEmpty((state) => state.empty);
  if (!empty) return null;
  return (
    <div
      data-slot="no-workspace-access"
      className="absolute inset-0 grid place-items-center"
    >
      <EmptyState title={t("sharing.noneLeft")} className="flex-none" />
    </div>
  );
}
