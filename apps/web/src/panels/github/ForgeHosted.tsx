import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { useT } from "@/app/preferences-store";
import type { ForgeDetection, ForgeScope } from "../../api/forge";
import { IssueDetail, OpenRemote, PullDetail } from "./ForgeDetail";
import { AddToCanvasButton } from "./ForgeItemMenu";
import { ForgeList, type ForgeView } from "./ForgeList";
import { forgeKeys } from "./forge-keys";

export { OpenRemote, forgeKeys };
export { ForgeListSkeleton } from "./ForgeListSkeleton";

/**
 * 代码托管面板的仓库视图（契约 §29.4）：GitHub、Gitea、GitLab 同一面，只读——
 * issue 与 PR / MR 的列表（按状态筛、翻页）和详情（标题、状态、标签、作者、
 * 更新时间、正文、在浏览器打开）。写操作（关闭、新建、合并、检出…）core 仍有，
 * 这一面不给。
 */

export type ForgeTab = "issues" | "pulls";

/**
 * 面板的导航状态：标签页、搜索串、视图、打开的条目。画布节点把它存进自己的数据
 * （只有这几样，没有令牌、正文与远端数据），面板用本地状态。
 */
export interface ForgeNav {
  tab: ForgeTab;
  query: string;
  view: ForgeView;
  open: { kind: "issue" | "pull"; number: number } | null;
}

export const DEFAULT_NAV: ForgeNav = {
  tab: "issues",
  query: "",
  view: "list",
  open: null,
};

export interface ForgeHostedProps {
  detection: ForgeDetection;
  locale: string;
  /** 打开面板的工作空间：它自己的托管配置优先（契约 §75）。 */
  workspaceId?: ForgeScope;
  /** 关着的面板不发请求。 */
  open: boolean;
  /**
   * 要直接打开的条目（画布上的连接徽标点进来）。`reveal` 每点一次加一，同一条
   * 点两次也会再定位过去。
   */
  focus?: {
    readonly tab: ForgeTab;
    readonly number: number;
    readonly reveal: number;
  } | null;
  /** 给了就由调用方持有导航状态（画布节点）；不给用本地状态。 */
  nav?: ForgeNav;
  onNav?: (nav: ForgeNav) => void;
}

const kindOf = (tab: ForgeTab) => (tab === "issues" ? "issue" : "pull");

export function ForgeHosted({
  detection,
  locale,
  workspaceId = null,
  open,
  focus = null,
  nav,
  onNav,
}: ForgeHostedProps) {
  const t = useT();
  const forge = detection.forge ?? "github";
  const repo = detection.repository;
  const [local, setLocal] = React.useState<ForgeNav>(() =>
    focus
      ? {
          ...DEFAULT_NAV,
          tab: focus.tab,
          open: { kind: kindOf(focus.tab), number: focus.number },
        }
      : DEFAULT_NAV,
  );
  const current = nav ?? local;
  const update = React.useCallback(
    (patch: Partial<ForgeNav>) => {
      const next = { ...(nav ?? local), ...patch };
      if (onNav) onNav(next);
      if (!nav) setLocal(next);
    },
    [nav, local, onNav],
  );
  const { tab, query, view } = current;
  const selected =
    current.open && current.open.kind === kindOf(tab)
      ? current.open.number
      : null;
  const [counts, setCounts] = React.useState<Record<ForgeTab, number | null>>({
    issues: null,
    pulls: null,
  });

  const reveal = focus?.reveal ?? 0;
  const focusTab = focus?.tab;
  const focusNumber = focus?.number;
  React.useEffect(() => {
    if (reveal === 0 || focusTab === undefined || focusNumber === undefined)
      return;
    update({
      tab: focusTab,
      open: { kind: kindOf(focusTab), number: focusNumber },
    });
    // 只在 reveal 变化时定位，update 随状态变不重复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, focusTab, focusNumber]);

  const openItem = (next: ForgeTab) => (number: number) =>
    update({ open: { kind: kindOf(next), number } });
  const close = () => update({ open: null });

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => update({ tab: value as ForgeTab, open: null })}
      className="min-w-0 gap-0"
      data-slot="forge-hosted"
      data-forge={forge}
    >
      <TabsList
        className="w-full shrink-0 rounded-none border-b border-border"
        variant="line"
      >
        <TabsTrigger value="issues" className="min-w-0 text-meta">
          {t("forge.tab.issues")}
          {counts.issues !== null && (
            <span className="tabular-nums text-muted-foreground">
              {counts.issues}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="pulls" className="min-w-0 text-meta">
          {t(`forge.tab.pulls.${forge === "gitlab" ? "gitlab" : "gitea"}`)}
          {counts.pulls !== null && (
            <span className="tabular-nums text-muted-foreground">
              {counts.pulls}
            </span>
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="issues"
        className="mt-0 min-w-0 data-[state=inactive]:hidden"
      >
        {selected !== null && tab === "issues" ? (
          <IssueDetail
            repo={repo}
            scope={workspaceId}
            number={selected}
            locale={locale}
            onBack={close}
            headerActions={
              <AddToCanvasButton repo={repo} kind="issue" number={selected} />
            }
          />
        ) : (
          <ForgeList
            kind="issues"
            repo={repo}
            scope={workspaceId}
            locale={locale}
            enabled={open && tab === "issues"}
            query={query}
            onQuery={(next) => update({ query: next })}
            view={view}
            onOpen={openItem("issues")}
            onCounts={(count) =>
              setCounts((previous) => ({ ...previous, issues: count }))
            }
          />
        )}
      </TabsContent>
      <TabsContent
        value="pulls"
        className="mt-0 min-w-0 data-[state=inactive]:hidden"
      >
        {selected !== null && tab === "pulls" ? (
          <PullDetail
            repo={repo}
            scope={workspaceId}
            number={selected}
            locale={locale}
            onBack={close}
            headerActions={
              <AddToCanvasButton repo={repo} kind="pull" number={selected} />
            }
          />
        ) : (
          <ForgeList
            kind="pulls"
            repo={repo}
            scope={workspaceId}
            locale={locale}
            enabled={open && tab === "pulls"}
            query={query}
            onQuery={(next) => update({ query: next })}
            view={view}
            onOpen={openItem("pulls")}
            onCounts={(count) =>
              setCounts((previous) => ({ ...previous, pulls: count }))
            }
          />
        )}
      </TabsContent>
    </Tabs>
  );
}
