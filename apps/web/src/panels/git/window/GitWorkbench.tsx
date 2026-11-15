import { useState } from "react";

import { useT } from "../../../app/preferences-store";
import { Tabs, TabsList, TabsTrigger } from "../../../ui/tabs";
import { CommitPage } from "../commit/CommitPage";
import { LogPage } from "../log/LogPage";

/**
 * Git 工作台（#935 C2，组件规格 §1、§9）：「日志」与「本地更改」两页，侧边栏的
 * Git 窗口与画布上的 Git 节点挂的都是它。
 *
 * - 日志里选中「未提交的变更」、或 Agent 节点菜单里的「Git：未提交的变更」，都
 *   切到「本地更改」。
 * - 两页同时挂着，只切显隐：回到日志时选中、滚动位置与展开的合并都还在。
 */
export function GitWorkbench({
  workspaceId,
  refreshToken = 0,
}: {
  workspaceId: string;
  refreshToken?: number;
}) {
  const t = useT();
  const [tab, setTab] = useState<"log" | "changes">("log");

  return (
    <div
      data-slot="git-workbench"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "log" | "changes")}
        className="shrink-0 gap-0 border-b border-border px-2"
      >
        <TabsList variant="line">
          <TabsTrigger value="log" className="text-meta">
            {t("gitLog.tab.log")}
          </TabsTrigger>
          <TabsTrigger value="changes" className="text-meta">
            {t("gitLog.tab.changes")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div
        hidden={tab !== "log"}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <LogPage
          workspaceId={workspaceId}
          refreshToken={refreshToken}
          onUncommitted={() => setTab("changes")}
        />
      </div>
      {tab === "changes" && (
        <CommitPage workspaceId={workspaceId} refreshToken={refreshToken} />
      )}
    </div>
  );
}
