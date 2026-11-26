import * as React from "react";
import type { TerminalAgent } from "@armadra/shared";

import { displayOfRow, type HeaderPill } from "@/agent/display";
import {
  headerStateFor,
  useProgramSeen,
  useProgramStatus,
  useProgramStatusStore,
} from "@/agent/program-status-store";
import type { SessionRow } from "@/agent/sessions";
import { useAgentStatus, useAgentStatusStore } from "@/agent/status-store";
import { headerApprovalOf } from "@/acp/plan-card";
import { answerHeaderApproval } from "@/approval/header-answer";
import { useT } from "@/app/preferences-store";
import { useBareLaunch } from "@/app/use-bare-launch";
import { useCanAnswer } from "@/app/use-access";
import { scoped } from "@/sources/scope";

export interface SessionHeader {
  readonly pill: HeaderPill;
  /** 头部一键允许 / 拒绝；答不了、没有待答或要去卡片里看时没有。 */
  readonly approval?:
    { readonly onAnswer: (decision: "allow" | "deny") => void } | undefined;
}

/**
 * 会话页头部的状态与审批：与节点头同一份输入（`headerStateFor`）、同一条规则
 * （零注入、没有答复权限、计划审批与提问都不给一键按钮，卡片在会话体里）。
 */
export function useSessionHeader(
  nodeId: string,
  agent: TerminalAgent | undefined,
  sessionId: string | null,
  workspaceId: string,
  row: SessionRow | undefined,
): SessionHeader {
  const t = useT();
  const status = useAgentStatus(nodeId);
  const program = useProgramStatus(nodeId);
  const seen = useProgramSeen(nodeId);
  const bare = useBareLaunch(agent?.id);
  const canAnswer = useCanAnswer(workspaceId, sessionId);
  const header = headerStateFor(Boolean(agent), status, program, seen);

  // 看着这条会话就算读过：本地清未读并回执，程序自报的 done / error 也收起光晕。
  const unread = status?.unread ?? false;
  React.useEffect(() => {
    const store = useAgentStatusStore.getState();
    if (store.statuses[scoped(nodeId)]?.unread) store.markRead(nodeId);
    useProgramStatusStore.getState().markSeen(nodeId);
  }, [nodeId, unread]);

  const need = header.display?.need ?? null;
  const asksQuestion =
    status?.state === "waiting" || status?.activity?.phase === "awaiting_input";
  const pendingId = status?.pendingId;
  const cardPending = headerApprovalOf(status).kind === "card";
  const approval =
    agent &&
    !bare &&
    canAnswer &&
    need === "approval" &&
    !asksQuestion &&
    !cardPending &&
    pendingId
      ? {
          onAnswer: (decision: "allow" | "deny") =>
            answerHeaderApproval(workspaceId, pendingId, decision, t),
        }
      : undefined;

  const pill: HeaderPill =
    header.pill ??
    (row
      ? (() => {
          const display = displayOfRow(row);
          return { tone: display.tone, labelKey: display.labelKey };
        })()
      : { tone: "queued", labelKey: "sessionPage.starting" });
  return { pill, approval };
}
