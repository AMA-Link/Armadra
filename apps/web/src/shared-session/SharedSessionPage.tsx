import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, X } from "lucide-react";

import { clientFor } from "@/api/client";
import { agentLabel } from "@/agent/launch";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Loadable } from "@/loading/Loadable";
import { SharedSessionBodySkeleton } from "./SharedSessionSkeleton";
import {
  ReadOnlyTerminal,
  type ReadOnlyTerminalState,
} from "./ReadOnlyTerminal";
import { ReadOnlyTranscript } from "./ReadOnlyTranscript";
import { type SharedSessionTarget, sourceNamed } from "./sessions";

/**
 * 被分享的那一条会话的只读查看页（#253、契约 §79）：占满画布那一块，顶栏是
 * 会话名与「只读」，下面是终端画面或 ACP 转录。没有任何输入入口；读写由 core
 * 判定，这页只是不摆出必然被拒的东西。
 */
export default function SharedSessionPage({
  target,
  onClose,
}: {
  target: SharedSessionTarget;
  /** 给了才有关闭按钮（浏览器里只有这一页的访客没有别处可去）。 */
  onClose?: (() => void) | undefined;
}) {
  const t = useT();
  const source = sourceNamed(target.sourceId);
  const row = useQuery({
    queryKey: ["shared-session", "row", target.sourceId, target.sessionId],
    queryFn: () =>
      clientFor(source!).terminals.get({ sessionId: target.sessionId }),
    enabled: source !== undefined,
    retry: (failures) => failures < 5,
    retryDelay: 2_000,
  });
  const [state, setState] = React.useState<ReadOnlyTerminalState>("connecting");
  const session = row.data;
  // 行上是驱动方式 `backend`（`terminalSessionSchema` 没有 `kind`：认它永远是终端）。
  const acp = session?.backend === "acp";
  const title =
    agentLabel(session?.agentId ?? undefined) ||
    session?.command ||
    t("sharedSession.terminal");
  const ended = session !== undefined && session.status !== "running";

  return (
    <section
      data-slot="shared-session"
      data-session={target.sessionId}
      aria-label={title}
      className="absolute inset-0 z-[var(--z-shared-session)] flex flex-col bg-background"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <h1 className="min-w-0 truncate font-medium">{title}</h1>
        <Badge variant="secondary" data-read-only>
          <Eye aria-hidden />
          {t("sharedSession.readOnly")}
        </Badge>
        {ended ? (
          <Badge variant="outline">{t("sharedSession.ended")}</Badge>
        ) : (
          !acp &&
          state === "offline" && (
            <Badge variant="outline">{t("sharedSession.offline")}</Badge>
          )
        )}
        <div className="flex-1" />
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("sharedSession.close")}
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1">
        {source === undefined || session === undefined ? (
          row.isError ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground">
                {t("sharedSession.failed")}
              </p>
            </div>
          ) : (
            <Loadable
              loading
              className="h-full"
              skeleton={<SharedSessionBodySkeleton />}
            >
              {null}
            </Loadable>
          )
        ) : acp ? (
          <ReadOnlyTranscript
            source={source}
            sessionId={target.sessionId}
            workspaceId={target.workspaceId}
          />
        ) : (
          <ReadOnlyTerminal
            source={source}
            sessionId={target.sessionId}
            onState={setState}
          />
        )}
      </div>
    </section>
  );
}
