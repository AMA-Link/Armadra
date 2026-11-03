import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";
import { usePreferencesStore } from "./preferences-store";
import { useAccess } from "./use-access";

/**
 * 把设置里关掉的 Agent 抄一份给 core 的 `agents.disabled`（契约 §97）。
 *
 * 开关本身仍然是本设备的偏好（`agentModes`，`preferences-store.ts`）；core 要
 * 知道它，是因为 Agent 能看到的东西——画布技能、MCP 说明、`canvas help` 与 ama
 * 的 runner 名单——和 `open-agent` / `team` 的派发都在 core 里。所以这里和
 * `useLocaleMirror` 一样做单向镜像：只抄 `disabled` 的那几家，读到的设置文档与
 * 当前不一致就整组写一次；全开了就写 `null` 删掉这个键。写失败不提示，下次
 * 再对。
 *
 * 服务器壳上的成员读写不了整台机器的设置（403），不镜像。
 */
export function useAgentModesMirror(): void {
  const client = useQueryClient();
  const member = useAccess().member;
  const modes = usePreferencesStore((state) => state.agentModes);
  const disabled = useMemo(
    () =>
      Object.entries(modes)
        .filter(([, mode]) => mode === "disabled")
        .map(([id]) => id)
        .sort(),
    [modes],
  );
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: runtimeApi.settings,
    retry: false,
    staleTime: 30_000,
    enabled: !member,
  });
  const loaded = settings.data !== undefined;
  const stored = useMemo(
    () => [...(settings.data?.agents?.disabled ?? [])].sort(),
    [settings.data],
  );
  const wanted = disabled.join("\n");
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (member || !loaded || stored.join("\n") === wanted) return;
    if (pending.current === wanted) return;
    pending.current = wanted;
    void runtimeApi
      .updateSettings({
        agents: { disabled: disabled.length === 0 ? null : disabled },
      })
      .then((next) => client.setQueryData(["settings"], next))
      .catch(() => undefined)
      .finally(() => {
        if (pending.current === wanted) pending.current = null;
      });
  }, [member, loaded, stored, wanted, disabled, client]);
}
