import * as React from "react";
import type { AcpAgentSession } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { createAgentNode } from "@/canvas/menus/add-menu";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/command";
import { Spinner } from "@/ui/spinner";
import { attachCwd, useAttachSessionStore } from "./attach-session";
import { useAgentSessions } from "./use-agent-sessions";

function label(session: AcpAgentSession): string {
  return session.title && session.title.trim() !== ""
    ? session.title
    : session.sessionId;
}

/** 最后一级目录名；列表里只需要认得出是哪个项目。 */
function folder(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * 接管已有会话的选择器（P2-7）：列出 Agent 自己历史里的会话，选一个建出节点。
 * 列表只在这个 Agent 报了 `session/list` 能力时才有入口；读不到就说读不到，
 * 可以重试。
 */
export function AttachSessionDialog() {
  const t = useT();
  const request = useAttachSessionStore((state) => state.request);
  const close = useAttachSessionStore((state) => state.close);
  const workspace = request?.context.workspace ?? null;
  const list = useAgentSessions(
    workspace?.id ?? null,
    request?.agent.id ?? null,
    workspace?.rootPath,
  );

  const pick = (session: AcpAgentSession) => {
    if (!request) return;
    const cwd = attachCwd(session, request.context.workspace.rootPath);
    createAgentNode(request.context, request.agent, t, {
      sessionId: session.sessionId,
      ...(cwd === undefined ? {} : { cwd }),
    });
    close();
  };

  return (
    <ResponsiveDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ResponsiveDialogContent className="gap-0 p-0 sm:max-w-md">
        <ResponsiveDialogHeader className="p-3 pb-2">
          <ResponsiveDialogTitle>
            {t("add.attachSession", { name: request?.agent.label ?? "" })}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {list.phase === "loading" ? (
          <div
            className="flex items-center justify-center p-6"
            data-slot="acp-sessions-loading"
          >
            <Spinner size={16} />
          </div>
        ) : list.phase === "failed" ? (
          <div className="flex items-center justify-between gap-2 p-3 text-body text-destructive">
            <span>{t("acp.sessions.failed")}</span>
            <Button size="xs" variant="outline" onClick={list.retry}>
              {t("acp.error.retry")}
            </Button>
          </div>
        ) : (
          <Command>
            <CommandInput placeholder={t("acp.sessions.search")} />
            <CommandList>
              <CommandEmpty>{t("acp.sessions.empty")}</CommandEmpty>
              <CommandGroup>
                {list.sessions.map((session) => (
                  <CommandItem
                    key={session.sessionId}
                    value={`${label(session)} ${session.cwd} ${session.sessionId}`}
                    onSelect={() => pick(session)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {label(session)}
                    </span>
                    <span className="max-w-32 shrink-0 truncate text-caption text-muted-foreground">
                      {session.cwd ? folder(session.cwd) : ""}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {list.hasMore && (
                <div className="p-1.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={list.paging}
                    onClick={list.more}
                  >
                    {t("acp.sessions.more")}
                  </Button>
                </div>
              )}
            </CommandList>
          </Command>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
