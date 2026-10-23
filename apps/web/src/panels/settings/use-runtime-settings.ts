import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";

import type { RuntimeSettingsPatch } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { settingsGateway } from "../../settings";
import { lk } from "./local-key";

/** 本机 core 的设置文档；设置页（除「当前工作空间」外）读写它。 */
export const LOCAL_SETTINGS_KEY = lk("settings");
/** 当前打开的工作空间所在 core 的设置文档（画布、快捷键等共用这一份）。 */
export const CURRENT_SETTINGS_KEY = ["settings"] as const;

/**
 * 设置文档的共享读写。`scope` 缺省 `current`（跟随打开的工作空间）；设置页传 `local` 恒指本机，「当前工作空间」
 * 页与 About 页保持 `current`。
 *
 * 每一页都用同一个 `["settings"]` 查询键：SSH、Agent、终端、数据几页改的
 * 是同一份文档，共享缓存就不会互相覆盖，也不会各自轮询。写成功后直接把
 * 回来的整份文档塞回缓存。
 *
 * 读写都经 `settingsGateway`，调用点只认它那两个方法。
 *
 * `enabled: false`：成员读不到设置文档（403），同一页里对成员开放的那部分
 * 用它免掉这次请求。
 */
export function useRuntimeSettings({
  enabled = true,
  scope = "current",
}: { enabled?: boolean; scope?: "local" | "current" } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const gateway = scope === "local" ? settingsGateway.local : settingsGateway;
  const key = scope === "local" ? LOCAL_SETTINGS_KEY : CURRENT_SETTINGS_KEY;
  const settings = useQuery({
    queryKey: key,
    queryFn: () => gateway.load(),
    retry: false,
    enabled,
  });
  const save = useMutation({
    mutationFn: (patch: RuntimeSettingsPatch) => gateway.patch(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      // 画布、快捷键、语言镜像读的是当前源的 `["settings"]`：存的是本机时让它们
      // 重读（当前源就是本机时才会变，别的源不受影响）。
      if (scope === "local")
        void queryClient.invalidateQueries({ queryKey: CURRENT_SETTINGS_KEY });
      // `agents.custom[]` 是 `GET /api/agents` 的一部分（§24.1）：存完自定义
      // Agent 就得让新建菜单、启动行那份快照重新拉一次，否则要等 60 秒。
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: lk("agents") });
    },
    onError: (cause: Error) =>
      toast.error(t("settings.saveFailed"), { description: cause.message }),
  });
  return { settings, save };
}
