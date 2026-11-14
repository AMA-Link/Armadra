import { useMemo } from "react";
import type { GitLogCommit } from "@armadra/shared";

import { useT } from "../../../app/preferences-store";
import { agentColorVar, agentLabel } from "../../../agent/launch";
import { cn } from "../../../lib/cn";
import { AgentAvatar } from "../../../ui/agent-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "../../../ui/avatar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../../../ui/hover-card";
import { refBadges } from "../CommitGraph";
import {
  commitAgents,
  githubAccountId,
  initials,
  type AgentMark,
} from "./people";

/**
 * 表格作者列（#927 B3）：头像 + 名字；有 Agent 协作时头像右下角一颗 Agent 标识
 * 色的点。悬停头像出浮卡：作者、协作的 Agent、仓库、提交号、时间与引用。浮卡
 * 只读，不放按钮——动作在右键菜单与右栏里。
 */

export function agentName(mark: AgentMark): string {
  return mark.id ? agentLabel(mark.id) : mark.label;
}

export function CommitAuthor({
  commit,
  avatars,
  repositoryName,
  narrow = false,
}: {
  commit: GitLogCommit;
  /** GitHub 账号 id → data URL；没有的画首字母。 */
  avatars: ReadonlyMap<number, string>;
  /** 仓库路径 → 名字；单仓库时不显示仓库这一行。 */
  repositoryName: string | null;
  narrow?: boolean;
}) {
  const t = useT();
  const agents = useMemo(() => commitAgents(commit), [commit]);
  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  const id = githubAccountId(commit.authorEmail);
  const image = id === null ? undefined : avatars.get(id);
  const lead = agents[0];
  const face = (size: "sm" | "default") => (
    <span className="relative inline-flex shrink-0">
      <Avatar size={size} className={cn(size === "sm" && "size-5")}>
        {image && <AvatarImage src={image} alt="" />}
        <AvatarFallback className="text-caption font-medium">
          {initials(commit.authorName)}
        </AvatarFallback>
      </Avatar>
      {lead && (
        <span
          aria-hidden
          data-slot="git-log-agent-dot"
          data-agent={lead.id ?? "other"}
          className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background"
          style={{ background: agentColorVar(lead.id ?? undefined) }}
        />
      )}
    </span>
  );

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          data-slot="git-log-author"
          className={cn(
            "flex shrink-0 items-center gap-1.5 truncate text-muted-foreground",
            narrow ? "w-auto" : "w-28",
          )}
          aria-label={
            lead
              ? t("gitLog.author.withAgent", {
                  name: commit.authorName,
                  agent: agents.map(agentName).join(", "),
                })
              : commit.authorName
          }
        >
          {face("sm")}
          {!narrow && <span className="truncate">{commit.authorName}</span>}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 p-0 text-meta">
        <div className="flex items-center gap-3 border-b border-border p-3">
          {face("default")}
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">
              {commit.authorName}
            </p>
            <p className="truncate text-caption text-muted-foreground">
              {commit.authorEmail}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-3">
          {agents.length > 0 && (
            <>
              <dt className="text-muted-foreground">
                {t("gitLog.author.agents")}
              </dt>
              <dd className="flex flex-wrap justify-end gap-1.5">
                {agents.map((mark) => (
                  <span
                    key={mark.id ?? mark.label}
                    className="inline-flex items-center gap-1"
                  >
                    {mark.id && <AgentAvatar agentId={mark.id} size={20} />}
                    {agentName(mark)}
                  </span>
                ))}
              </dd>
            </>
          )}
          {repositoryName && (
            <>
              <dt className="text-muted-foreground">
                {t("gitLog.author.repository")}
              </dt>
              <dd className="truncate text-right">{repositoryName}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("gitLog.author.commit")}</dt>
          <dd className="text-right font-mono">{commit.oid.slice(0, 7)}</dd>
          <dt className="text-muted-foreground">{t("gitLog.author.time")}</dt>
          <dd className="text-right" data-numeric>
            {commit.committerTime.replace("T", " ").slice(0, 16)}
          </dd>
          {badges.length > 0 && (
            <>
              <dt className="text-muted-foreground">
                {t("gitLog.author.refs")}
              </dt>
              <dd className="truncate text-right">
                {badges.map((badge) => badge.label).join(" · ")}
              </dd>
            </>
          )}
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}
