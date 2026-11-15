import * as React from "react";
import { LayoutList, Columns3 } from "lucide-react";

import { useT, usePreferencesStore } from "@/app/preferences-store";
import { ScrollArea } from "@/ui/scroll-area";
import { EmptyState } from "@/ui/state";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { useCanvasStore } from "@/store/canvas-store";
import {
  DEFAULT_NAV,
  ForgeHosted,
  type ForgeNav,
  OpenRemote,
} from "@/panels/github/ForgeHosted";
import { useForgeTarget } from "@/panels/github/forge-target";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/**
 * 画布上的代码托管节点（#934）：内容就是侧边面板那一份列表与详情
 * （`ForgeHosted`），同一份组件、同一套缓存。节点只记仓库坐标（空则按工作空间
 * 自动识别）、标签页、搜索串、视图与打开的条目编号；令牌、正文与远端数据每次
 * 现读，不进画布文档。头部「列表 / 看板」切换视图。
 */
export function ForgeNode({ node, selected }: NodeBodyProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data.kind === "forge" ? node.data : null;
  const target = useForgeTarget(data?.repo ?? null, workspaceId);
  const nav: ForgeNav = data
    ? { tab: data.tab, query: data.query, view: data.view, open: data.open }
    : DEFAULT_NAV;
  const onNav = React.useCallback(
    (next: ForgeNav) =>
      updateNodeData(node.id, {
        tab: next.tab,
        query: next.query,
        view: next.view,
        open: next.open,
      }),
    [node.id, updateNodeData],
  );
  const detection = target.status === "ready" ? target.detection : null;

  return (
    <NodeShell
      node={node}
      selected={selected}
      headerActions={
        <>
          <ToggleGroup
            type="single"
            size="sm"
            value={nav.view}
            aria-label={t("forge.node.view")}
            onValueChange={(value) => {
              if (value) onNav({ ...nav, view: value as ForgeNav["view"] });
            }}
          >
            <ToggleGroupItem
              value="list"
              aria-label={t("forge.node.view.list")}
              title={t("forge.node.view.list")}
            >
              <LayoutList />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="board"
              aria-label={t("forge.node.view.board")}
              title={t("forge.node.view.board")}
            >
              <Columns3 />
            </ToggleGroupItem>
          </ToggleGroup>
          {detection && <OpenRemote url={detection.webUrl ?? ""} />}
        </>
      }
    >
      <div
        data-slot="forge-node"
        className="flex h-full min-h-0 min-w-0 flex-col"
      >
        {detection ? (
          <ScrollArea className="min-h-0 flex-1">
            <ForgeHosted
              key={`${detection.repository.host}/${detection.repository.owner}/${detection.repository.name}`}
              detection={detection}
              locale={locale}
              workspaceId={workspaceId}
              open
              nav={nav}
              onNav={onNav}
            />
          </ScrollArea>
        ) : (
          <ForgeTargetState target={target} />
        )}
      </div>
    </NodeShell>
  );
}

/** 节点里认不出仓库、没有登录或连不上时的一句实话。 */
export function ForgeTargetState({
  target,
}: {
  target: ReturnType<typeof useForgeTarget>;
}) {
  const t = useT();
  const title =
    target.status === "blocked"
      ? t(`github.blocked.${target.reason}`)
      : target.status === "noRepo"
        ? t(`forge.reason.${target.reason}`)
        : target.status === "unknown"
          ? t("forge.unknown")
          : target.status === "noLogin"
            ? t("forge.noLogin", { host: target.detection.repository.host })
            : target.status === "error"
              ? t(target.messageKey)
              : t("state.loading");
  return (
    <div data-slot="forge-node-state" data-status={target.status}>
      <EmptyState inline title={title} />
    </div>
  );
}
