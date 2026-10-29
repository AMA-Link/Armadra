import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { IconButton } from "@/ui/icon-button";
import { RelativeTime } from "../ui/RelativeTime";
import type { AuditEvent } from "./data";

/** 超过这么多行才虚拟化（云端控制台 §4.3）。 */
export const VIRTUAL_THRESHOLD = 50;

const ROW = 44;
const ROW_COMPACT = 60;
const DETAIL = 76;
const COLUMNS =
  "grid-cols-[7rem_10rem_minmax(0,1fr)_minmax(0,1fr)_8rem_2.5rem] gap-x-3";

/** 动作名的文案；认不出的动作显示原名。 */
export function useActionLabel() {
  const t = useT();
  return (action: string) => {
    const key = `cloud.audit.a.${action}`;
    const label = t(key);
    return label === key ? action : label;
  };
}

export interface AuditNames {
  /** 账号 id → 成员名。 */
  readonly members: ReadonlyMap<string, string>;
  /** 主机 id → 主机名。 */
  readonly hosts: ReadonlyMap<string, string>;
}

function useWho(names: AuditNames) {
  const t = useT();
  return (event: AuditEvent): { text: string; person: boolean } => {
    const { kind, id } = event.actor;
    if (kind === "account")
      return {
        text:
          (id ? names.members.get(id) : undefined) ??
          t("cloud.audit.unknownMember"),
        person: true,
      };
    return { text: t(`cloud.audit.by.${kind}`), person: false };
  };
}

function useTargetText(names: AuditNames) {
  const t = useT();
  return (event: AuditEvent): string => {
    const target = event.target;
    if (!target) return "";
    const named =
      target.kind === "account"
        ? names.members.get(target.id)
        : target.kind === "host"
          ? names.hosts.get(target.id)
          : undefined;
    const kindKey = `cloud.audit.kind.${target.kind}`;
    const kind = t(kindKey) === kindKey ? target.kind : t(kindKey);
    return named ? `${kind} · ${named}` : kind;
  };
}

/** 展开后的明细：对象 id、`jti`、IP 前缀，等宽、固定三行。 */
function Detail({ event }: { event: AuditEvent }) {
  const t = useT();
  const rows: readonly (readonly [string, string | null])[] = [
    [t("cloud.audit.objectId"), event.target?.id ?? null],
    [t("cloud.audit.jti"), event.jti],
    [t("cloud.audit.ipPrefix"), event.ipPrefix],
  ];
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] content-center gap-x-4 gap-y-1 bg-sunken px-3 font-mono text-caption"
      style={{ height: DETAIL }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="truncate" translate="no">
            {value ?? "—"}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/**
 * 审计表（云端控制台 §3.3.10）：时间 · 成员 · 动作 · 对象 · IP 前缀，行尾展开明细。超过
 * {@link VIRTUAL_THRESHOLD} 行用虚拟列表（只渲染窗口内的行），行高固定，所以展开只是换一个高度。
 * 窄屏同一份数据画成两行：动作与时间，成员 · 对象。
 */
export function AuditList({
  events,
  names,
  caption,
}: {
  events: readonly AuditEvent[];
  names: AuditNames;
  caption: string;
}) {
  const t = useT();
  const compact = useCompactLayout();
  const actionLabel = useActionLabel();
  const who = useWho(names);
  const targetText = useTargetText(names);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const scroller = React.useRef<HTMLDivElement>(null);
  const virtual = events.length > VIRTUAL_THRESHOLD;
  const base = compact ? ROW_COMPACT : ROW;
  const heightOf = (index: number) =>
    base + (open.has(events[index]?.eventId ?? "") ? DETAIL : 0);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scroller.current,
    estimateSize: heightOf,
    overscan: 8,
    getItemKey: (index) => events[index]?.eventId ?? index,
    enabled: virtual,
  });
  // 展开 / 收起或换布局：行高变了，重新量。
  React.useEffect(() => {
    virtualizer.measure();
  }, [open, compact, virtualizer]);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const renderRow = (
    event: AuditEvent,
    index: number,
    place?: { top: number },
  ) => {
    const name = actionLabel(event.action);
    const person = who(event);
    const expanded = open.has(event.eventId);
    const toggleButton = (
      <IconButton
        size="cluster"
        label={t(expanded ? "cloud.audit.collapse" : "cloud.audit.expand", {
          name,
        })}
        aria-expanded={expanded}
        onClick={() => toggle(event.eventId)}
      >
        <ChevronDown
          className={cn("transition-transform", expanded && "rotate-180")}
        />
      </IconButton>
    );
    const target = targetText(event);
    return (
      <div
        key={event.eventId}
        role="row"
        aria-rowindex={index + 2}
        data-event={event.eventId}
        className={cn(
          "border-b border-border/60",
          place && "absolute inset-x-0 top-0",
        )}
        {...(place
          ? { style: { transform: `translateY(${place.top}px)` } }
          : {})}
      >
        {compact ? (
          <div
            className="flex items-center gap-2 px-3"
            style={{ height: base }}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span role="cell" className="min-w-0 truncate">
                  {name}
                </span>
                <span role="cell" className="shrink-0 text-caption">
                  <RelativeTime ms={event.atMs} />
                </span>
              </div>
              <div className="flex min-w-0 gap-x-1 text-caption text-muted-foreground">
                <span role="cell" className="min-w-0 truncate" translate="no">
                  {person.text}
                </span>
                {target ? (
                  <>
                    <span aria-hidden>·</span>
                    <span role="cell" className="min-w-0 truncate">
                      {target}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <span role="cell">{toggleButton}</span>
          </div>
        ) : (
          <div
            className={cn("grid items-center px-3", COLUMNS)}
            style={{ height: base }}
          >
            <span role="cell" className="text-caption">
              <RelativeTime ms={event.atMs} />
            </span>
            <span role="cell" className="flex min-w-0 items-center gap-2">
              {person.person ? (
                <Avatar size="sm">
                  <AvatarFallback>{[...person.text][0]}</AvatarFallback>
                </Avatar>
              ) : null}
              <span className="truncate" translate="no">
                {person.text}
              </span>
            </span>
            <span role="cell" className="truncate">
              {name}
            </span>
            <span role="cell" className="truncate text-muted-foreground">
              {target}
            </span>
            <span
              role="cell"
              className="truncate font-mono text-caption text-muted-foreground tabular-nums"
              translate="no"
            >
              {event.ipPrefix ?? ""}
            </span>
            <span role="cell">{toggleButton}</span>
          </div>
        )}
        {expanded ? <Detail event={event} /> : null}
      </div>
    );
  };

  const header = compact ? null : (
    <div
      role="row"
      aria-rowindex={1}
      className={cn(
        "grid border-b border-border px-3 py-2 text-caption text-muted-foreground",
        COLUMNS,
      )}
    >
      <span role="columnheader">{t("cloud.audit.time")}</span>
      <span role="columnheader">{t("cloud.audit.actor")}</span>
      <span role="columnheader">{t("cloud.audit.action")}</span>
      <span role="columnheader">{t("cloud.audit.target")}</span>
      <span role="columnheader">{t("cloud.audit.ipPrefix")}</span>
      <span role="columnheader" aria-hidden />
    </div>
  );

  return (
    <div
      role="table"
      aria-label={caption}
      aria-rowcount={events.length + 1}
      className="flex min-h-0 flex-col rounded-card border border-border"
    >
      {header}
      <div
        ref={scroller}
        role="rowgroup"
        data-slot="audit-rows"
        data-virtual={virtual}
        className="max-h-[calc(100dvh-18rem)] min-h-64 overflow-y-auto"
      >
        {virtual ? (
          <div
            role="presentation"
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer
              .getVirtualItems()
              .map((item) =>
                renderRow(events[item.index]!, item.index, { top: item.start }),
              )}
          </div>
        ) : (
          events.map((event, index) => (
            <React.Fragment key={event.eventId}>
              {renderRow(event, index)}
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  );
}
