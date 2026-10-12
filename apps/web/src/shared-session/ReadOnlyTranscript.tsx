import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { acpLogResponseSchema } from "@armadra/shared";

import { clientFor } from "@/api/client";
import type { Source } from "@/api/source";
import { useT } from "@/app/preferences-store";
import { MessageList } from "@/acp/MessageList";
import { fromLog } from "@/acp/store";
import { ScrollArea } from "@/ui/scroll-area";
import { Spinner } from "@/ui/spinner";

/** 多久重读一次镜像：会话查看者不订阅工作空间事件，靠定时读跟上。 */
const POLL_MS = 2_000;

/**
 * ACP 会话的只读转录：按 `acp.log` 读镜像（契约 §43.1），只画消息列表——没有
 * 输入框、审批与 elicitation 按钮，消息上只有复制。
 */
export function ReadOnlyTranscript({
  source,
  sessionId,
}: {
  source: Source;
  sessionId: string;
}) {
  const t = useT();
  const log = useQuery({
    queryKey: ["shared-session", "acp-log", source.sourceId, sessionId],
    queryFn: async () =>
      acpLogResponseSchema.parse(
        await clientFor(source).acp.log({ sessionId, after: 0 }),
      ),
    refetchInterval: POLL_MS,
    retry: false,
  });
  const items = React.useMemo(
    () => (log.data ? fromLog(log.data.entries).items : []),
    [log.data],
  );
  if (log.data === undefined)
    return (
      <div className="flex h-full items-center justify-center">
        {log.isError ? (
          <p className="text-muted-foreground">{t("sharedSession.failed")}</p>
        ) : (
          <Spinner
            aria-label={t("sharedSession.loading")}
            className="size-4 text-muted-foreground"
          />
        )}
      </div>
    );
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-3xl px-4 py-4">
        {items.length === 0 ? (
          <p className="text-center text-muted-foreground">
            {t("sharedSession.empty")}
          </p>
        ) : (
          <MessageList items={items} streaming={false} />
        )}
      </div>
    </ScrollArea>
  );
}
