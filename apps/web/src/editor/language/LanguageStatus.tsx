import * as React from "react";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { countDiagnostics, useDiagnosticsStore } from "./diagnostics-store";
import type { Ownership } from "./documents";
import { statusLabelKey, type SessionStatus } from "./status-store";

/**
 * 编辑器状态栏最右边那一格（语言服务设计 §4.2 `LanguageStatus.tsx`）。
 *
 * 它替换掉从前写死的「LSP 未启用」。三种情况说三句不同的话：
 *
 *  * 文件根本不适用（非 UTF-8、超过 1 MiB、认不出语言）→ 不画：没有会话
 *    可重启，说一句「不适用」只是每个纯文本文件多一个词。
 *  * 有会话 → 状态 +（不可用时）原因；点开可以重启 / 停止那台 server。
 *  * 这个节点是跟随者（§2.5）→ 额外说一句「跟随另一节点」，因为它的编辑
 *    确实不进 LSP，用户该知道。
 */
export function LanguageStatus({
  status,
  ownership,
  applicable,
}: {
  status: Pick<
    SessionStatus,
    "state" | "reason" | "serverId" | "reconnecting"
  > | null;
  ownership: Ownership | null;
  /** 这个文件能不能有语言会话。 */
  applicable: boolean;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const byUri = useDiagnosticsStore((state) => state.byUri);
  const counts = React.useMemo(() => countDiagnostics(byUri), [byUri]);
  const [busy, setBusy] = React.useState(false);

  // 文件不适用语言服务（非 UTF-8、过大、认不出语言）：没有会话可说，什么都不画。
  if (!applicable) return null;

  const label = t(statusLabelKey(status as SessionStatus | undefined));
  const reason =
    status?.reason && !status.reconnecting
      ? t(`lsp.reason.${status.reason}`)
      : null;

  const control = async (action: "restart" | "stop") => {
    if (!workspaceId || !status?.serverId) return;
    setBusy(true);
    try {
      await (action === "restart"
        ? runtimeApi.restartLanguageServer(workspaceId, status.serverId)
        : runtimeApi.stopLanguageServer(workspaceId, status.serverId));
    } catch {
      // 失败的原因会随 `language.server` 事件回到状态里；这里不再弹一次。
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="ml-auto flex items-center gap-2">
      {ownership === "follower" && <span>{t("lsp.following")}</span>}
      {(counts.errors > 0 || counts.warnings > 0) && (
        <Button
          variant="ghost"
          size="xs"
          type="button"
          className="px-1 text-caption font-normal text-inherit hover:text-foreground"
          onClick={() => setPanel("problems", "drawer")}
        >
          {t("problems.summary", {
            errors: String(counts.errors),
            warnings: String(counts.warnings),
          })}
        </Button>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            type="button"
            className="px-1 text-caption font-normal text-inherit hover:text-foreground"
          >
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="z-(--z-menu) flex w-auto min-w-40 flex-col gap-2 p-2 text-caption"
        >
          {status?.serverId && (
            <span className="font-medium">{status.serverId}</span>
          )}
          {reason && <span className="text-muted-foreground">{reason}</span>}
          {status && status.state !== "unsupported" && (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void control("restart")}
              >
                {t("lsp.restart")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void control("stop")}
              >
                {t("lsp.stop")}
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}
