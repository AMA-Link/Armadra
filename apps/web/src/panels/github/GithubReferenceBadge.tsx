import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";
import { Skeleton } from "@/ui/skeleton";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { openGithubPanel } from "./open";
import {
  referenceTab,
  referenceTarget,
  useGithubReferences,
} from "./references";
import {
  FORGE_NAMES,
  type ForgeRepo,
  forgeIssue,
  forgePull,
} from "../../api/forge";
import type { GithubExternalReference } from "../../api/github";
import { ForgeChecksSummary } from "./ForgeChecksSummary";
import { ForgeItemRow } from "./ForgeItemRow";
import { forgeKeys } from "./forge-keys";

/**
 * 悬浮卡：面板列表里的同一行（{@link ForgeItemRow}），不另做画布版；点一下打开面板
 * 里的详情。悬停时才取条目，缓存与面板详情共用。
 */
function ReferenceCard({
  reference,
  repo,
  open,
  onOpen,
}: {
  reference: GithubExternalReference;
  repo: ForgeRepo;
  open: boolean;
  onOpen: () => void;
}) {
  const locale = usePreferencesStore((state) => state.locale);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const pull = referenceTab(reference) === "pulls";
  const number = Number(reference.number);
  const issue = useQuery({
    queryKey: forgeKeys.issue(repo, number, workspaceId),
    queryFn: () => forgeIssue(repo, number, workspaceId),
    enabled: open && !pull,
    retry: false,
  });
  const change = useQuery({
    queryKey: forgeKeys.pull(repo, number, workspaceId),
    queryFn: () => forgePull(repo, number, workspaceId),
    enabled: open && pull,
    retry: false,
  });
  const item = pull ? change : issue;
  if (!item.data)
    return item.isError ? null : <Skeleton className="h-12 w-full" />;
  return (
    <ForgeItemRow
      kind={pull ? "pull" : "issue"}
      item={item.data}
      locale={locale}
      onOpen={onOpen}
    />
  );
}

function ReferenceBadge({
  reference,
  checks,
}: {
  reference: GithubExternalReference;
  checks: boolean;
}) {
  const t = useT();
  const [hovered, setHovered] = React.useState(false);
  const target = referenceTarget(reference);
  const repo: ForgeRepo | null = target
    ? { host: target.host, owner: target.owner, name: target.name }
    : null;
  const tab = referenceTab(reference);
  const openPanel = () =>
    openGithubPanel(tab, reference.number, referenceTarget(reference));
  const badge = (
    <Badge asChild variant="outline" className="cursor-pointer">
      <Button
        variant="ghost"
        size="xs"
        type="button"
        title={reference.title || t("github.reference.open")}
        aria-label={t("github.reference.open")}
        onClick={(event) => {
          event.stopPropagation();
          openPanel();
        }}
      >
        {reference.forge && reference.forge !== "github"
          ? `${FORGE_NAMES[reference.forge] ?? reference.forge} `
          : ""}
        #{String(reference.number)}
      </Button>
    </Badge>
  );
  return (
    <>
      {repo ? (
        <HoverCard openDelay={250} onOpenChange={setHovered}>
          <HoverCardTrigger asChild>{badge}</HoverCardTrigger>
          <HoverCardContent
            data-slot="forge-reference-card"
            className="w-80 p-0"
          >
            <ReferenceCard
              reference={reference}
              repo={repo}
              open={hovered}
              onOpen={openPanel}
            />
          </HoverCardContent>
        </HoverCard>
      ) : (
        badge
      )}
      {checks && repo && tab === "pulls" && (
        <ForgeChecksSummary
          repo={repo}
          number={Number(reference.number)}
          compact
        />
      )}
    </>
  );
}

/**
 * The hosted items linked to a terminal or frame node (canvas platform §4).
 * A Gitea / GitLab link names its platform; a GitHub one stays a bare `#n`.
 *
 * A badge, a hover preview and a way back to the item: a session is not turned
 * into a task card, and nothing is drawn at all when the GitHub session is not
 * ready. A frame bound to a PR (`checks`) also shows the PR's check summary.
 */
export function GithubReferenceBadge({
  nodeId,
  checks = false,
}: {
  nodeId: string;
  checks?: boolean;
}) {
  const references = useGithubReferences(nodeId);
  if (references.length === 0) return null;
  return (
    <>
      {references.map((reference) => (
        <ReferenceBadge
          key={reference.referenceId}
          reference={reference}
          checks={checks}
        />
      ))}
    </>
  );
}
