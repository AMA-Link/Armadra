import * as React from "react";
import type { AgentInfo } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";
import { acpApi } from "./api";

/** 退出登录只在 core 报了这家声明了 `logout` 且客户端跑得了时才有。 */
export function canSignOut(agent: AgentInfo): boolean {
  return agent.acp?.capabilities?.logout === true;
}

/** 设置里 Agent 子页的「退出登录」：让 core 对这家适配器发 `logout`。 */
export function SignOutButton({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const [busy, setBusy] = React.useState(false);
  if (!canSignOut(agent) || workspaceId === null) return null;
  const run = async () => {
    setBusy(true);
    try {
      await acpApi.logout(workspaceId, agent.id);
      toast.success(t("acp.auth.signedOut"));
    } catch {
      toast.error(t("acp.auth.signOutFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" size="sm" loading={busy} onClick={() => void run()}>
      {t("acp.auth.signOut")}
    </Button>
  );
}
