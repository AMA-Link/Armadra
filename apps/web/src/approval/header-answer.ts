import type { Translate } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import { answerApproval } from "@/nodes/runtime-extras";
import { toast } from "@/ui/toast";

/**
 * 头部「允许 / 拒绝」的答复（节点头与会话页头部共用）。
 *
 * 先收起按钮：Runtime 的下一条 `agent.status` 未必立刻到，让人对着一个已经答过的
 * 请求再点一次是最糟的。没答上就把按钮放回去并说一声（回合还卡在这条审批上）；
 * 终端卡上的键没被看到生效（契约 §127）时也说出来，让人去终端看一眼。
 */
export function answerHeaderApproval(
  workspaceId: string,
  pendingId: string,
  decision: "allow" | "deny",
  t: Translate,
): void {
  const statusKey = useAgentStatusStore.getState().resolveApproval(pendingId);
  answerApproval(workspaceId, pendingId, decision).then(
    (delivery) => {
      if (delivery !== undefined && delivery !== "confirmed") {
        toast.error(t(`acp.permission.delivery.${delivery}`), {
          duration: 12_000,
        });
      }
    },
    () => {
      if (statusKey !== undefined) {
        useAgentStatusStore.getState().reopenApproval(statusKey, pendingId);
      }
      toast.error(t("acp.permission.failed"));
    },
  );
}
