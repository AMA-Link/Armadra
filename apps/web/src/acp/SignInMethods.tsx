import * as React from "react";
import type { AcpAuthMethodInfo } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";
import { acpApi } from "./api";

/**
 * 起会话遇到 `acp_auth_required` 时，Agent 声明的登录方式各一个按钮。点了就让
 * core 完成它（agent 型由适配器自己做，terminal 型由 core 跑），成功后交还
 * `onDone` 重试起会话；失败留在原处，可以换一种再试。
 */
export function SignInMethods({
  agentId,
  methods,
  onDone,
}: {
  agentId: string;
  methods: readonly AcpAuthMethodInfo[];
  onDone: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = React.useState<string | null>(null);

  const signIn = async (method: AcpAuthMethodInfo) => {
    const workspace = useCanvasStore.getState().workspace;
    if (busy !== null || !workspace) return;
    setBusy(method.id);
    try {
      await acpApi.authenticate(workspace.id, agentId, method.id);
      onDone();
    } catch {
      toast.error(t("acp.auth.failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-slot="acp-sign-in" className="flex flex-wrap gap-1.5 pt-1.5">
      {methods.map((method) => (
        <Button
          key={method.id}
          size="xs"
          variant="outline"
          title={method.description}
          loading={busy === method.id}
          disabled={busy !== null && busy !== method.id}
          onClick={() => void signIn(method)}
        >
          {method.name}
        </Button>
      ))}
    </div>
  );
}
