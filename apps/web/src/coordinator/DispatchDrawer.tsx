import { activeSourceId, unscoped } from "@/sources/scope";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";

import { onWorkspaceConnection } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { agentColorVar } from "@/agent/launch";
import type { AgentTree as AgentTreeModel } from "@/agent/agent-tree-model";
import { useAgentStatusStore } from "@/agent/status-store";
import { useAgentTree } from "@/agent/use-agent-tree";
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { terminalHandle } from "@/nodes/terminal-registry";
import { WorkPanelSheet } from "@/panels/WorkPanelSheet";
import { useCanvasStore } from "@/store/canvas-store";
import { AgentAvatar } from "@/ui/agent-avatar";
import { AgentTree } from "@/ui/agent-tree";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { IconButton } from "@/ui/icon-button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/ui/item";
import { ScrollArea } from "@/ui/scroll-area";
import { SheetTitle } from "@/ui/sheet";
import { SkeletonList } from "@/ui/skeletons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { StatusLine } from "@/ui/status-pill";
import { toast } from "@/ui/toast";
import { coordinatorApi, coordinatorKeys } from "./api";
import {
  type DispatchMember,
  type DispatchModel,
  buildDispatch,
  coordinatorsOf,
  nodeOfItem,
} from "./model";
import { IntakeTab } from "./IntakeTab";
import { SourcesTab } from "./SourcesTab";
import { closeDispatchDrawer, useDispatchTarget } from "./store";

/**
 * 协调者（ama）的分派抽屉（设计系统 §5.4）：右侧 `--drawer-w`，顶部缩略 Agent 树
 * （根 = ama）、ama 一行、成员一行一个（左侧 2px Agent 色、`StatusLine`：状态 ·
 * 耗时）、汇总便签「打开」、失败行「重试」（契约 §15.7：把任务提示词从 ama 再投一次）。
 *
 * 五态（§5.16）：空 → 一句 + 聚焦 ama；加载 → Skeleton；错误 → 行内
 * `Alert destructive` + 重试；权限 → 不能起 Agent 的人看到「只读」而不是
 * 「重试」；离线 → 顶部 `Alert`，整棵树置灰、按钮禁用。
 */

export interface DispatchViewProps {
  readonly model: DispatchModel;
  /** 顶部的缩略 Agent 树（`useAgentTree(ama)`）；没有下级时不传。 */
  readonly tree?: AgentTreeModel | null;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly offline?: boolean;
  /** 能不能重试（`agent:launch`）。 */
  readonly canRetry?: boolean;
  /** 正在重试的任务。 */
  readonly retrying?: string | null;
  /** 打开抽屉时还没读的回复所在的任务：这些行高亮（契约 §101）。 */
  readonly fresh?: ReadonlySet<string>;
  readonly onReload?: () => void;
  readonly onRetry?: (taskId: string) => void;
  readonly onOpen?: (nodeId: string) => void;
  readonly onFocusLead?: () => void;
}

const NO_TASKS: ReadonlySet<string> = new Set();

/** 纯展示：真抽屉与展示页共用。 */
export function DispatchView({
  model,
  tree = null,
  loading = false,
  error = false,
  offline = false,
  canRetry = true,
  retrying = null,
  fresh = NO_TASKS,
  onReload,
  onRetry,
  onOpen,
  onFocusLead,
}: DispatchViewProps) {
  const t = useT();
  const empty =
    !loading && model.members.length === 0 && model.summaries.length === 0;

  return (
    <div
      data-slot="dispatch-view"
      className="flex min-w-0 flex-col gap-(--space-block) p-(--space-page)"
    >
      {offline ? (
        <Alert data-slot="dispatch-offline">
          <AlertTitle className="text-meta">
            {t("coordinator.offline")}
          </AlertTitle>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" data-slot="dispatch-error">
          <AlertTitle className="text-meta">
            {t("coordinator.error")}
          </AlertTitle>
          {onReload ? (
            <AlertAction>
              <Button size="xs" variant="outline" onClick={onReload}>
                {t("coordinator.reload")}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}

      {tree ? (
        <div
          data-slot="dispatch-agent-tree"
          className={cn(offline && "opacity-50")}
        >
          <AgentTree tree={tree} size="md" />
        </div>
      ) : null}

      <div
        data-slot="dispatch-tree"
        data-offline={offline ? "true" : undefined}
        aria-disabled={offline || undefined}
        className={cn("flex min-w-0 flex-col gap-1", offline && "opacity-50")}
      >
        {model.lead ? (
          <Item size="xs" className="px-2" data-slot="dispatch-lead">
            <ItemMedia>
              <AgentAvatar agentId={model.lead.agentId || "ama"} size={20} />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full min-w-0">
                <span className="truncate">{model.lead.title}</span>
              </ItemTitle>
              {model.lead.status ? (
                <StatusLine
                  tone={model.lead.status.tone}
                  label={t(model.lead.status.label)}
                  spinning={model.lead.status.tone === "working"}
                />
              ) : null}
            </ItemContent>
          </Item>
        ) : null}

        {loading ? (
          <div className="pl-3" data-slot="dispatch-loading">
            <SkeletonList rows={3} size="tall" label={t("state.loading")} />
          </div>
        ) : empty && !error ? (
          <Empty className="border-0 p-6" data-slot="dispatch-empty">
            <EmptyHeader>
              <EmptyTitle className="text-body font-normal text-muted-foreground">
                {t("coordinator.empty")}
              </EmptyTitle>
            </EmptyHeader>
            {onFocusLead ? (
              <EmptyContent>
                <Button size="sm" disabled={offline} onClick={onFocusLead}>
                  {t("coordinator.empty.focus")}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <ItemGroup className="gap-1 pl-3" data-slot="dispatch-members">
            {model.members.map((member) => (
              <MemberRow
                key={member.nodeId}
                member={member}
                offline={offline}
                canRetry={canRetry}
                retrying={retrying === member.taskId}
                fresh={member.taskId !== null && fresh.has(member.taskId)}
                {...(onRetry ? { onRetry } : {})}
                {...(onOpen ? { onOpen } : {})}
              />
            ))}
            {model.summaries.map((summary) => (
              <Item
                key={summary.nodeId}
                size="xs"
                variant="muted"
                className="px-2"
                data-slot="dispatch-summary"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full min-w-0 font-normal">
                    <span className="truncate">
                      {t("coordinator.summary", {
                        title: summary.title || t("coordinator.untitled"),
                      })}
                    </span>
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={offline}
                    onClick={() => onOpen?.(summary.nodeId)}
                  >
                    {t("coordinator.open")}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>
    </div>
  );
}

function MemberRow({
  member,
  offline,
  canRetry,
  retrying,
  fresh,
  onRetry,
  onOpen,
}: {
  member: DispatchMember;
  /** 打开抽屉时还没读的回复：这一行高亮，直到抽屉关上。 */
  fresh: boolean;
  offline: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry?: (taskId: string) => void;
  onOpen?: (nodeId: string) => void;
}) {
  const t = useT();
  const failed = member.status.tone === "failed";
  return (
    <Item
      size="xs"
      className={cn(
        "rounded-none border-0 border-l-2 px-2",
        fresh && "bg-accent",
      )}
      style={{ borderLeftColor: agentColorVar(member.agentId) }}
      data-slot="dispatch-member"
      data-node-id={member.nodeId}
      data-tone={member.status.tone}
      data-fresh={fresh ? "true" : undefined}
    >
      <ItemMedia>
        <AgentAvatar agentId={member.agentId || "custom:"} size={20} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full min-w-0">
          <Button
            variant="link"
            className="h-auto min-w-0 justify-start p-0 text-foreground"
            disabled={offline}
            onClick={() => onOpen?.(member.nodeId)}
          >
            <span className="truncate">
              {member.title || t("coordinator.untitled")}
            </span>
          </Button>
        </ItemTitle>
        <StatusLine
          tone={member.status.tone}
          label={t(member.status.label)}
          detail={
            member.elapsedMs !== null
              ? formatDuration(member.elapsedMs)
              : undefined
          }
          spinning={member.status.tone === "working"}
        />
        {member.pulls.length > 0 ? (
          <div className="flex flex-wrap gap-x-2" data-slot="dispatch-pulls">
            {member.pulls.map((pull) =>
              /^https?:\/\//i.test(pull.url) ? (
                <Button
                  key={`${pull.repo}#${pull.number}`}
                  asChild
                  variant="link"
                  size="xs"
                  className="h-auto p-0"
                >
                  <a
                    href={pull.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={t("coordinator.pull", { number: pull.number })}
                    data-own={pull.own ? "true" : undefined}
                  >
                    #{pull.number}
                  </a>
                </Button>
              ) : (
                <span
                  key={`${pull.repo}#${pull.number}`}
                  className="text-meta text-muted-foreground"
                >
                  #{pull.number}
                </span>
              ),
            )}
          </div>
        ) : null}
        {member.reply !== null ? (
          <ItemDescription
            data-slot="dispatch-reply"
            data-purpose={member.reply.purpose}
          >
            {member.reply.text}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {member.stalled !== undefined ? (
        <Badge
          variant="outline"
          size="sm"
          data-slot="dispatch-stalled"
          data-stalled={member.stalled}
        >
          {t(`agent.stall.${member.stalled}`)}
        </Badge>
      ) : null}
      {failed && member.taskId !== null && member.retryable ? (
        <ItemActions>
          {canRetry ? (
            <Button
              size="xs"
              variant="outline"
              disabled={offline}
              loading={retrying}
              data-slot="dispatch-retry"
              onClick={() => onRetry?.(member.taskId as string)}
            >
              {t("coordinator.retry")}
            </Button>
          ) : (
            <Badge variant="outline">{t("coordinator.readOnly")}</Badge>
          )}
        </ItemActions>
      ) : null}
    </Item>
  );
}

/* ------------------------------- 真抽屉 ------------------------------- */

/**
 * 运行中的行多久重算一次耗时。任务行本身不轮询：`workflow.task` 帧到达时重读
 * （契约 §15.4、§15.7，订阅在 `workflow/store.ts::useWorkflowEvents`）。
 */
const ELAPSED_TICK_MS = 15_000;

/** 有运行中的行时每隔一会儿给一个新的「此刻」，耗时跟着走。 */
function useTick(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function useWorkspaceOnline(workspaceId: string | null): boolean {
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    if (!workspaceId) return;
    setOnline(true);
    return onWorkspaceConnection((id, next, from) => {
      if (id === workspaceId && from === activeSourceId()) setOnline(next);
    });
  }, [workspaceId]);
  return online;
}

/** 选中、居中，终端就把键盘焦点交给它。 */
function revealNode(nodeId: string, focusInput = false): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  requestCenterOnNode(nodeId);
  if (focusInput) terminalHandle(nodeId)?.focus();
}

type DrawerTab = "members" | "sources" | "intake";

export function DispatchDrawer() {
  const t = useT();
  const mode = useCanvasStore((state) => state.panels.dispatch);
  const boardId = useCanvasStore((state) => state.boardId);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const document = useCanvasStore((state) => state.document);
  const coordinatorId = useDispatchTarget((state) => state.nodeId);
  const statuses = useAgentStatusStore((state) => state.statuses);
  const tree = useAgentTree(coordinatorId);
  const access = useAccess();
  const online = useWorkspaceOnline(workspaceId);
  const client = useQueryClient();
  const open = mode === "drawer";
  const canEdit = access.can("agent:launch", workspaceId ?? "");
  const [tab, setTab] = React.useState<DrawerTab>("members");

  const tasks = useQuery({
    queryKey: coordinatorKeys.tasks(boardId ?? ""),
    queryFn: () => coordinatorApi.tasks(boardId as string),
    enabled: open && Boolean(boardId),
    retry: false,
  });

  // 断线期间的帧收不到：重新连上就重读一次。
  const refetch = tasks.refetch;
  const wasOnline = React.useRef(online);
  React.useEffect(() => {
    if (open && online && !wasOnline.current) void refetch();
    wasOnline.current = online;
  }, [open, online, refetch]);

  // 耗时跟着走：运行中的那几行每秒一跳太吵，十几秒一跳就够。
  const running =
    open && (tasks.data ?? []).some((task) => task.status === "running");
  const tick = useTick(running);
  const now = Math.max(tick, tasks.dataUpdatedAt || 0) || Date.now();
  const model = React.useMemo(() => {
    const states: Record<string, (typeof statuses)[string]["state"]> = {};
    const stalled: Record<string, (typeof statuses)[string]["stalled"]> = {};
    // 只取当前源的那些，键还原成节点 id。
    const here = activeSourceId();
    for (const [key, status] of Object.entries(statuses)) {
      const { sourceId, id } = unscoped(key);
      if (sourceId === here) {
        states[id] = status.state;
        stalled[id] = status.stalled;
      }
    }
    return buildDispatch({
      coordinatorId,
      nodes: document?.nodes ?? [],
      edges: document?.edges ?? [],
      tasks: tasks.data ?? [],
      states,
      stalled,
      now,
    });
  }, [coordinatorId, document, tasks.data, statuses, now]);

  // 打开抽屉就标已读（契约 §101.2）；这一次打开时还没读的那几行高亮到关上。
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(new Set());
  const markRead = useMutation({
    mutationFn: (board: string) => coordinatorApi.readReplies(board),
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: coordinatorKeys.tasks(boardId ?? ""),
      }),
  });
  const markReadNow = markRead.mutate;
  React.useEffect(() => {
    if (!open) {
      setFresh((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }
    const unread = (tasks.data ?? []).filter(
      (task) =>
        task.coordinatorNodeId === coordinatorId &&
        task.reply !== null &&
        !task.reply.read,
    );
    if (unread.length === 0 || !boardId) return;
    setFresh(
      (previous) => new Set([...previous, ...unread.map((t) => t.taskId)]),
    );
    markReadNow(boardId);
  }, [open, tasks.data, coordinatorId, boardId, markReadNow]);

  const retry = useMutation({
    mutationFn: (taskId: string) => coordinatorApi.retry(taskId),
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: coordinatorKeys.tasks(boardId ?? ""),
      }),
    onError: () => toast.error(t("coordinator.retryFailed")),
  });

  return (
    <WorkPanelSheet panel="dispatch" open={open} onClose={closeDispatchDrawer}>
      <div className="flex h-(--row-h-table) shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="flex-1 truncate text-body font-semibold">
          {t("coordinator.title")}
        </SheetTitle>
        <IconButton
          label={t("coordinator.reload")}
          onClick={() => {
            void tasks.refetch();
            if (boardId) {
              for (const queryKey of [
                coordinatorKeys.sources(boardId),
                coordinatorKeys.intakeAll(boardId),
              ]) {
                void client.invalidateQueries({ queryKey });
              }
            }
          }}
        >
          <RotateCw />
        </IconButton>
        <IconButton
          label={t("coordinator.close")}
          onClick={closeDispatchDrawer}
        >
          <X />
        </IconButton>
      </div>
      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next as DrawerTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList variant="line" className="mx-3 mt-2 shrink-0">
          <TabsTrigger value="members">
            {t("coordinator.tab.members")}
          </TabsTrigger>
          <TabsTrigger value="sources">
            {t("coordinator.tab.sources")}
          </TabsTrigger>
          <TabsTrigger value="intake">
            {t("coordinator.tab.intake")}
          </TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1">
          <TabsContent value="members">
            <DispatchView
              model={model}
              tree={tree}
              loading={tasks.isPending && tasks.fetchStatus !== "idle"}
              error={tasks.isError}
              offline={!online}
              canRetry={canEdit}
              retrying={retry.isPending ? (retry.variables ?? null) : null}
              fresh={fresh}
              onReload={() => void tasks.refetch()}
              onRetry={(taskId) => retry.mutate(taskId)}
              onOpen={(nodeId) => revealNode(nodeId)}
              onFocusLead={() => {
                if (coordinatorId) revealNode(coordinatorId, true);
              }}
            />
          </TabsContent>
          <TabsContent value="sources">
            {boardId ? (
              <SourcesTab
                boardId={boardId}
                coordinators={coordinatorsOf(document?.nodes ?? [])}
                defaultCoordinator={coordinatorId}
                offline={!online}
                canEdit={canEdit}
                active={open && tab === "sources"}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="intake">
            {boardId ? (
              <IntakeTab
                boardId={boardId}
                offline={!online}
                canEdit={canEdit}
                active={open && tab === "intake"}
                nodeOf={(itemId) => nodeOfItem(tasks.data ?? [], itemId)}
                onOpenNode={(nodeId) => revealNode(nodeId)}
              />
            ) : null}
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </WorkPanelSheet>
  );
}
