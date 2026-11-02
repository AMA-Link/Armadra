import { useEffect } from "react";
import { toast } from "@/ui/toast";

import {
  CLOSE_REVOKED,
  closeMessageKey,
  onControlClosed,
  onControlOpened,
} from "../api/ws";
import { t } from "./preferences-store";

/**
 * 控制面停下了（契约 §35.2）：版本不兼容（4409）或订阅数到顶（4429）时重连只会
 * 撞上同一堵墙，用一句话说明怎么办。授权收回（4403）由
 * `use-access-lost.ts` 按工作空间说，这里不重复。控制面重新连上时收起这些提示。
 */
export function useControlNotices(): void {
  useEffect(() => {
    // 挂着的那几条：控制面重新连上就收起（#706）——续上凭据之后还挂着一条
    // 「登录已过期」只会让人以为还断着。
    const shown = new Set<string>();
    const offClosed = onControlClosed((code) => {
      if (code === CLOSE_REVOKED) return;
      const key = closeMessageKey(code);
      if (key === undefined) return;
      const id = `control-closed-${code}`;
      shown.add(id);
      toast.error(t(key), { id });
    });
    const offOpened = onControlOpened(() => {
      for (const id of shown) toast.dismiss(id);
      shown.clear();
    });
    return () => {
      offClosed();
      offOpened();
    };
  }, []);
}
