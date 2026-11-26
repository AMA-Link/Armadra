import * as React from "react";
import { displayName } from "@/sidebar/display-name";
import { Plus } from "lucide-react";

import { agentLabel, agentMark } from "@/agent/launch";
import { displayOfRow } from "@/agent/display";
import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useRoving } from "@/ui/roving";
import { StatusDot, type StatusTone } from "@/ui/status-pill";
import {
  filterTree,
  groupTree,
  type AgentSessionItem,
  type AgentSessionNode,
} from "./model";

/** 超过这么多条才出现过滤框。 */
export const FILTER_THRESHOLD = 6;

function statusOf(
  item: AgentSessionItem,
  t: ReturnType<typeof useT>,
): { tone: StatusTone; label: string } {
  if (!item.session)
    return { tone: "queued", label: t("sessionPage.starting") };
  const display = displayOfRow(item.session);
  return { tone: display.tone, label: t(display.labelKey) };
}

export function SessionList({
  tree,
  count,
  selectedNodeId,
  onSelect,
  onNew,
  empty,
}: {
  tree: readonly AgentSessionNode[];
  count: number;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onNew: () => void;
  /** 列表空着时放在列表区顶部（不是整栏底部）。 */
  empty?: React.ReactNode;
}) {
  const t = useT();
  const roving = useRoving<HTMLElement>();
  const [filter, setFilter] = React.useState("");
  const groups = React.useMemo(
    () => groupTree(filterTree(tree, filter)),
    [tree, filter],
  );

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 委托容器：键盘导航交给行内的 roving 焦点，过滤框自己处理按键
    <nav
      aria-label={t("sessionPage.title")}
      data-slot="session-list"
      className="flex min-h-0 flex-1 flex-col"
      ref={roving.ref}
      onFocusCapture={roving.onFocusCapture}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        roving.onKeyDown(event);
      }}
    >
      <div className="flex flex-col gap-2 p-2">
        <Button variant="outline" size="sm" onClick={onNew}>
          <Plus />
          {t("sessionPage.new")}
        </Button>
        {count > FILTER_THRESHOLD && (
          <Input
            size="sm"
            value={filter}
            placeholder={t("sessions.filter")}
            aria-label={t("sessions.filter")}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || filter === "") return;
              event.stopPropagation();
              event.preventDefault();
              setFilter("");
            }}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {count === 0 && empty}
        {groups.map((group) => (
          <section key={group.bucket} data-bucket={group.bucket}>
            <h3 className="flex items-center gap-1 px-2 py-1 text-caption font-medium text-muted-foreground">
              {t(
                group.bucket === "starting"
                  ? "sessionPage.starting"
                  : `sessions.bucket.${group.bucket}`,
              )}
              <span className="tabular-nums">{countNodes(group.nodes)}</span>
            </h3>
            {group.nodes.map((node) => (
              <SessionTreeRow
                key={node.item.nodeId}
                node={node}
                depth={0}
                selectedNodeId={selectedNodeId}
                onSelect={onSelect}
              />
            ))}
          </section>
        ))}
      </div>
    </nav>
  );
}

function countNodes(nodes: readonly AgentSessionNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function SessionTreeRow({
  node,
  depth,
  selectedNodeId,
  onSelect,
}: {
  node: AgentSessionNode;
  depth: number;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const t = useT();
  const { item } = node;
  const status = statusOf(item, t);
  const agentId = item.data.agent?.id ?? "";
  const selected = item.nodeId === selectedNodeId;
  return (
    <>
      <Button
        variant="ghost"
        data-roving-item
        data-selected={selected ? "true" : undefined}
        data-node-id={item.nodeId}
        aria-current={selected ? "true" : undefined}
        title={agentLabel(agentId)}
        className={cn(
          "h-auto min-h-12 w-full flex-col items-stretch justify-center gap-0 rounded-control py-1 pr-2 font-normal hover:bg-hover data-[selected=true]:bg-brand-soft data-[selected=true]:text-strong",
        )}
        style={{ paddingLeft: `calc(0.5rem + ${depth * 16}px)` }}
        onClick={() => onSelect(item.nodeId)}
      >
        <span className="flex w-full items-center gap-2">
          <AgentAvatar agentId={agentId} size={20} text={agentMark(agentId)} />
          <span className="flex-1 truncate text-left text-body">
            {item.title}
          </span>
          <StatusDot tone={status.tone} size={8} label={status.label} />
        </span>
        <span className="truncate pl-7 text-left text-caption font-normal text-muted-foreground">
          {displayName(item.boardName, t)}
        </span>
      </Button>
      {node.children.map((child) => (
        <SessionTreeRow
          key={child.item.nodeId}
          node={child}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
