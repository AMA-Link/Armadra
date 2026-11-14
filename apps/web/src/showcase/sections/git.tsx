import * as React from "react";

import { LogTable } from "@/panels/git/log/LogTable";
import { GIT_LOG_COLORS, GIT_LOG_COMMITS } from "../fixtures/git";

const noop = () => undefined;

/**
 * `git` 分区（#927）：三个仓库按时间交错的提交图。左边是按合并折叠、其中一个
 * 合并展开；右边是关掉折叠的完整 DAG，两张图用同一页数据，便于对照。
 */
export default function GitSection() {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () =>
      new Set([
        `Armadra:${GIT_LOG_COMMITS.find((c) => c.subject.includes("#919"))!.oid}`,
      ]),
  );
  const [selected, setSelected] = React.useState<string | null>(null);
  const table = (collapse: boolean) => (
    <div
      data-git-graph={collapse ? "collapsed" : "full"}
      className="flex h-[560px] min-w-0 flex-col overflow-hidden rounded-card border border-border bg-background"
    >
      <LogTable
        commits={GIT_LOG_COMMITS}
        colors={GIT_LOG_COLORS}
        selected={selected}
        onSelect={(key) => setSelected(key)}
        uncommitted={["Armadra"]}
        compact={false}
        showHash={false}
        myEmail={null}
        hasMore={false}
        loading={false}
        onLoadMore={noop}
        collapseMerges={collapse}
        expanded={expanded}
        onToggleMerge={(key) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
      />
    </div>
  );
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {table(true)}
      {table(false)}
    </div>
  );
}
