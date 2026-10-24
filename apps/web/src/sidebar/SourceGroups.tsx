import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Folder } from "lucide-react";

import { reorderSources } from "../api/remote-services";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { useT } from "../app/preferences-store";
import { isDesktop } from "../platform";
import { useOpenWorkspace } from "../app/workspace-actions";
import { useWorkspaces } from "../app/workspaces-query";
import { sourcePill } from "../panels/settings/source-status";
import {
  type SourceConnection,
  useCurrentSource,
  useSources,
} from "../sources";
import { originOf, shareRoleOf } from "../sources/origin";
import { SharedSessionRows } from "../shared-session/SharedSessionRows";
import { cachedWorkspaces } from "../sources/workspace-cache";
import {
  type SourceSection,
  type WorkspaceGroupKey,
  groupByTeam,
  groupWorkspaces,
  initialOf,
  ownerNameOf,
  sourceNameOf,
} from "../sources/workspace-groups";
import { cn } from "@/lib/cn";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { StatusDot } from "@/ui/status-pill";
import { toast } from "@/ui/toast";

/**
 * 侧栏的三组（#301）：这台电脑、我的其他电脑、他人分享。点哪个工作空间就
 * 打开哪个画布，当前源跟着打开的工作空间走（`sources/follow-workspace.ts`），
 * 没有手动切换。
 *
 * 打开着的工作空间所在的那台电脑，这一段是 `tree`（已打开的工作空间与它们的
 * 画布）；其余每台各一段，列出它的全部工作空间。每段各自的状态：在连、离线
 * 时灰着列上次记下的名字，点不开，也不挡本机那一段。
 *
 * 「我的其他电脑」按段头拖动排序（桌面壳与服务器壳的页面，源表在本机 core）：
 * 新顺序写回 `sources.update.orderIndex`，侧栏先按新顺序画，不为此重连。
 */
interface WorkspaceGroupsProps {
  /** 当前那台电脑的那一段（已打开的工作空间树）。 */
  tree: React.ReactNode;
  /** 「这台电脑」组的外壳（组标题、添加项目、拖入目录），内容由这里给。 */
  renderLocal: (content: React.ReactNode, current: boolean) => React.ReactNode;
}

export function WorkspaceGroups(props: WorkspaceGroupsProps) {
  const sources = useSources();
  // 零配置只有本机：不多发一次各源的工作空间查询。
  if (sources.length < 2)
    return props.renderLocal(
      <div
        data-source-group={sources[0]?.descriptor.sourceId}
        data-state="ready"
      >
        {props.tree}
      </div>,
      true,
    );
  return <Groups {...props} sources={sources} />;
}

function Groups({
  tree,
  renderLocal,
  sources,
}: WorkspaceGroupsProps & { sources: readonly SourceConnection[] }) {
  const t = useT();
  const current = useCurrentSource();
  const workspaces = useWorkspaces();
  const [order, setOrder] = React.useState<readonly string[] | null>(null);
  const groups = groupWorkspaces({
    sources,
    states: workspaces.states,
    listings: workspaces.perSource,
    cached: cachedWorkspaces,
  });
  const openWorkspace = useOpenWorkspace();
  const currentId = current.descriptor.sourceId;
  // 当前源跟着打开的工作空间换过去（`sources/follow-workspace.ts`）。
  const open = (sourceId: string, workspaceId: string) => {
    const found = workspaces.data.find(
      (one) => one.sourceId === sourceId && one.workspace.id === workspaceId,
    );
    if (found) openWorkspace(found.workspace as never, sourceId);
  };
  const contentOf = (section: SourceSection) =>
    section.connection.descriptor.sourceId === currentId ? (
      tree
    ) : (
      <WorkspaceRows section={section} onOpen={open} />
    );

  return (
    <>
      {groups.map((group) => {
        if (group.key === "local") {
          const section = group.sections[0]!;
          return (
            <React.Fragment key="local">
              {renderLocal(
                <div
                  data-source-group={section.connection.descriptor.sourceId}
                  data-state={section.state}
                >
                  {contentOf(section)}
                </div>,
                section.connection.descriptor.sourceId === currentId,
              )}
            </React.Fragment>
          );
        }
        return (
          <section
            key={group.key}
            aria-label={t(`workspaceGroups.${group.key}`)}
            data-workspace-group={group.key}
            className="mt-2"
          >
            <GroupHeading>{t(`workspaceGroups.${group.key}`)}</GroupHeading>
            {group.key === "shared" ? (
              <SharedTeams sections={group.sections} contentOf={contentOf} />
            ) : (
              <RemoteSections
                kind={group.key}
                sections={group.sections}
                order={order}
                onOrder={setOrder}
                allSources={sources}
                contentOf={contentOf}
              />
            )}
          </section>
        );
      })}
    </>
  );
}

function GroupHeading({ children }: { children: string }) {
  return (
    <div className="flex items-center px-1.5 py-1.5">
      <h2 className="min-w-0 flex-1 truncate text-caption font-medium tracking-[.04em] text-muted-foreground uppercase">
        {children}
      </h2>
    </div>
  );
}

/** 团队小组的展开状态存在本机（契约 §86）：缺省展开，折起记 `0`。 */
function teamOpenKey(teamId: string): string {
  return `armadra.sidebar.teams.${teamId}`;
}

function readTeamOpen(teamId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(teamOpenKey(teamId)) !== "0";
  } catch {
    return true;
  }
}

function writeTeamOpen(teamId: string, open: boolean): void {
  try {
    globalThis.localStorage?.setItem(teamOpenKey(teamId), open ? "1" : "0");
  } catch {
    /* 记不下只是下次又展开。 */
  }
}

/**
 * 「他人分享」按团队分小组（云端控制台 §3.5.4）：团队小组在前，各是一个可折叠的
 * 标题；不经团队的分享在后，形态不变。只有一个团队且没有个人分享时不画小组标题。
 */
function SharedTeams({
  sections,
  contentOf,
}: {
  sections: readonly SourceSection[];
  contentOf: (section: SourceSection) => React.ReactNode;
}) {
  const t = useT();
  const { teams, personal } = groupByTeam(sections);
  const blocks = (list: readonly SourceSection[]) =>
    list.map((section) => (
      <SourceBlock
        key={section.connection.descriptor.sourceId}
        kind="shared"
        section={section}
      >
        {contentOf(section)}
      </SourceBlock>
    ));
  if (teams.length === 0) return <>{blocks(personal)}</>;
  const titled = teams.length > 1 || personal.length > 0;
  return (
    <>
      {teams.map((team) =>
        titled ? (
          <TeamGroupBlock key={team.teamId} team={team}>
            {blocks(team.sections)}
          </TeamGroupBlock>
        ) : (
          <div key={team.teamId} data-team-group={team.teamId}>
            {blocks(team.sections)}
          </div>
        ),
      )}
      {personal.length > 0 && (
        <section aria-label={t("workspaceGroups.personal")} data-team-group="">
          <h3 className="flex h-(--row-h) items-center px-1.5 text-caption font-medium text-muted-foreground">
            {t("workspaceGroups.personal")}
          </h3>
          {blocks(personal)}
        </section>
      )}
    </>
  );
}

function TeamGroupBlock({
  team,
  children,
}: {
  team: { teamId: string; name: string };
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(() => readTeamOpen(team.teamId));
  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writeTeamOpen(team.teamId, next);
      }}
    >
      <section aria-label={team.name} data-team-group={team.teamId}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-1.5 px-1.5 text-caption font-medium text-muted-foreground"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                !open && "-rotate-90",
              )}
            />
            <span className="min-w-0 truncate">{team.name}</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** 源表在本机 core 里、能写回顺序的页面（同 `sources/bootstrap.ts` 的判断）。 */
function canReorder(): boolean {
  return isDesktop() || RUNTIME_VIA_SERVER_SHELL;
}

/** 拖动定下的顺序先盖在源表的顺序上：认得的按它排，其余按原顺序跟在后面。 */
export function applyOrder<T extends { connection: SourceConnection }>(
  sections: readonly T[],
  order: readonly string[] | null,
): T[] {
  if (order === null) return [...sections];
  const rank = new Map(order.map((sourceId, index) => [sourceId, index]));
  const idOf = (entry: T) => entry.connection.descriptor.sourceId;
  return sections
    .map((section, index) => ({ section, index }))
    .sort(
      (a, b) =>
        (rank.get(idOf(a.section)) ?? order.length + a.index) -
        (rank.get(idOf(b.section)) ?? order.length + b.index),
    )
    .map((entry) => entry.section);
}

function RemoteSections({
  kind,
  sections,
  order,
  onOrder,
  allSources,
  contentOf,
}: {
  kind: Exclude<WorkspaceGroupKey, "local">;
  sections: readonly SourceSection[];
  order: readonly string[] | null;
  onOrder: (order: readonly string[] | null) => void;
  allSources: readonly SourceConnection[];
  contentOf: (section: SourceSection) => React.ReactNode;
}) {
  const t = useT();
  const client = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const ordered = applyOrder(sections, order);
  const sortable = kind === "mine" && canReorder() && ordered.length > 1;

  if (!sortable) {
    return ordered.map((section) => (
      <SourceBlock
        key={section.connection.descriptor.sourceId}
        kind={kind}
        section={section}
      >
        {contentOf(section)}
      </SourceBlock>
    ));
  }

  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over;
    if (!over || event.active.id === over.id) return;
    const ids = ordered.map(
      (section) => section.connection.descriptor.sourceId,
    );
    const next = arrayMove(
      ids,
      ids.indexOf(String(event.active.id)),
      ids.indexOf(String(over.id)),
    );
    onOrder(next);
    // 我的电脑按新顺序在前，分享来的按原顺序跟在后面。
    const rest = allSources
      .filter(
        (source) =>
          source.descriptor.kind !== "local" &&
          !next.includes(source.descriptor.sourceId),
      )
      .map((source) => source.descriptor.sourceId);
    void reorderSources([...next, ...rest]).then(
      () => client.invalidateQueries({ queryKey: ["sources"] }),
      (error: Error) => {
        onOrder(null);
        toast.error(error.message);
      },
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={ordered.map((section) => section.connection.descriptor.sourceId)}
        strategy={verticalListSortingStrategy}
      >
        {ordered.map((section) => (
          <SortableSourceBlock
            key={section.connection.descriptor.sourceId}
            section={section}
            reorderLabel={(name) => t("remote.sources.reorder", { name })}
          >
            {contentOf(section)}
          </SortableSourceBlock>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableSourceBlock({
  section,
  reorderLabel,
  children,
}: {
  section: SourceSection;
  reorderLabel(name: string): string;
  children: React.ReactNode;
}) {
  const sortable = useSortable({
    id: section.connection.descriptor.sourceId,
  });
  return (
    <SourceBlock
      kind="mine"
      section={section}
      sortable={{
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Transform.toString(sortable.transform),
          transition: sortable.transition,
          zIndex: sortable.isDragging ? 1 : undefined,
        },
        handle: { ...sortable.attributes, ...sortable.listeners },
        label: reorderLabel,
        dragging: sortable.isDragging,
      }}
    >
      {children}
    </SourceBlock>
  );
}

interface SortableProps {
  readonly ref: (node: HTMLElement | null) => void;
  readonly style: React.CSSProperties;
  readonly handle: React.HTMLAttributes<HTMLDivElement>;
  readonly label: (name: string) => string;
  readonly dragging: boolean;
}

/** 段的状态 → 状态点与读屏文字（在连用转圈）。 */
function pillOf(section: SourceSection) {
  const state = section.connection.status.state;
  if (section.state === "ready") return sourcePill("ready");
  if (section.state === "loading")
    return sourcePill(state === "ready" ? "connecting" : state);
  return sourcePill(
    state === "unauthorized" || state === "waitingForSource"
      ? state
      : "offline",
  );
}

/** 一台电脑那一段：段头（我的：状态点与名字；分享的：主人头像、名字与权限）与内容。 */
function SourceBlock({
  kind,
  section,
  sortable,
  children,
}: {
  kind: Exclude<WorkspaceGroupKey, "local">;
  section: SourceSection;
  sortable?: SortableProps;
  children: React.ReactNode;
}) {
  const t = useT();
  const connection = section.connection;
  const sourceId = connection.descriptor.sourceId;
  const shared = kind === "shared";
  const name = shared ? ownerNameOf(connection) : sourceNameOf(connection);
  const pill = pillOf(section);
  return (
    <section
      ref={sortable?.ref}
      style={sortable?.style}
      aria-label={name}
      data-source-group={sourceId}
      data-state={section.state}
      data-dragging={sortable?.dragging || undefined}
      className={cn(
        "relative",
        sortable?.dragging && "rounded-control bg-sidebar shadow-overlay",
      )}
    >
      <div
        {...sortable?.handle}
        aria-label={sortable ? sortable.label(name) : undefined}
        className={cn(
          "flex h-(--row-h) items-center gap-2 rounded-control px-1.5",
          section.state === "offline" && "opacity-60",
          sortable &&
            "cursor-grab touch-none outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing",
        )}
      >
        {shared ? (
          <Avatar size="sm" className="size-5" aria-hidden>
            <AvatarFallback className="text-caption">
              {initialOf(name)}
            </AvatarFallback>
          </Avatar>
        ) : section.state === "loading" ? (
          <Spinner size={12} aria-hidden className="text-muted-foreground" />
        ) : (
          <StatusDot tone={pill.tone} size={6} />
        )}
        <h3 className="min-w-0 flex-1 truncate text-body text-muted-foreground">
          {name}
        </h3>
        {shared && section.state === "loading" && (
          <Spinner size={12} aria-hidden className="text-muted-foreground" />
        )}
        {shared && (
          <Badge variant="secondary" data-share-role>
            {t(`workspaceGroups.role.${shareRoleOf(connection.descriptor)}`)}
          </Badge>
        )}
        <span className="sr-only">{t(pill.key)}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * 不是当前那台的电脑：列出它的工作空间；在连、离线时灰着、点不开。分享给我的
 * 主机没有工作空间时，列出分享给我的会话（契约 §79）。
 */
function WorkspaceRows({
  section,
  onOpen,
}: {
  section: SourceSection;
  onOpen: (sourceId: string, workspaceId: string) => void;
}) {
  const sourceId = section.connection.descriptor.sourceId;
  const usable = section.state === "ready" && !section.stale;
  if (section.workspaces.length === 0)
    return originOf(section.connection.descriptor) === "shared" ? (
      <SharedSessionRows sourceId={sourceId} usable={usable} />
    ) : null;
  return (
    <ul data-stale={section.stale || undefined}>
      {section.workspaces.map((workspace) => (
        <li key={workspace.id}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!usable}
            data-source-workspace={workspace.id}
            className="w-full justify-start gap-2 px-1.5 font-normal"
            onClick={() => onOpen(sourceId, workspace.id)}
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{workspace.name}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
