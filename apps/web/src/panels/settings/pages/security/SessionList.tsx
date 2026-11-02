import * as React from "react";
import type { IdentitySessionRow, Lockout } from "@armadra/shared";
import { ChevronRight, Globe, Laptop, Smartphone } from "lucide-react";

import { useT } from "../../../../app/preferences-store";
import {
  ConfirmRemove,
  SecuritySection,
  SecuritySectionSkeleton,
  useDateTime,
} from "./parts";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
} from "@/ui/pagination";
import { Spinner } from "@/ui/spinner";
import { Switch } from "@/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

/** 一页放几台设备。 */
export const SESSION_PAGE_SIZE = 8;

/** 同一台设备（`deviceId`）的会话，归成列表里的一行。 */
export interface SessionGroup {
  readonly deviceId: string;
  /** 当前的排第一，其余按最近活动从近到远。 */
  readonly sessions: readonly IdentitySessionRow[];
  /** 这一组里有没有发这个请求的那一个。 */
  readonly current: boolean;
  /** 组里最晚的活动。 */
  readonly lastActiveMs: number;
}

/**
 * 按设备归并（#706）：桌面壳的页面与托盘、同一部手机重新配对过几次，都是同一台
 * 设备的几条会话。已经过期的不出现。当前设备排第一，其余按最近活动排。
 */
export function groupSessions(
  sessions: readonly IdentitySessionRow[],
  now: number = Date.now(),
): SessionGroup[] {
  const byDevice = new Map<string, IdentitySessionRow[]>();
  for (const session of sessions) {
    if (session.expiresAtMs <= now) continue;
    const list = byDevice.get(session.deviceId);
    if (list) list.push(session);
    else byDevice.set(session.deviceId, [session]);
  }
  return [...byDevice.entries()]
    .map(([deviceId, list]) => {
      const ordered = [...list].sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          lastActive(b) - lastActive(a),
      );
      return {
        deviceId,
        sessions: ordered,
        current: ordered.some((session) => session.current),
        lastActiveMs: Math.max(...ordered.map(lastActive)),
      };
    })
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.lastActiveMs - a.lastActiveMs,
    );
}

/**
 * 会话与设备（设计系统 §5.10，契约 §18.4）：一台设备一行 · 最近活动 · IP · [退出]；
 * 有几条会话的设备可展开，逐条退出。当前这一个带「当前」；底部「退出其他全部」
 * 与分页。owner 可以切到所有人的会话。
 */
export function SessionList({
  sessions,
  everyone,
  canSeeEveryone,
  names,
  busy,
  onEveryone,
  onRevoke,
  onRevokeOthers,
  loading = false,
}: {
  sessions: readonly IdentitySessionRow[] | undefined;
  everyone: boolean;
  canSeeEveryone: boolean;
  /** principalId → 显示名（所有人视图里的成员列）。 */
  names?: ReadonlyMap<string, string>;
  /** 正在退出的 `sessionId`，或 `"others"`。 */
  busy: string | null;
  onEveryone(value: boolean): void;
  onRevoke(session: IdentitySessionRow): void;
  onRevokeOthers(): void;
  /** 第一次取数中（还没有 `sessions`）。 */
  loading?: boolean;
}) {
  const t = useT();
  const when = useDateTime();
  const [confirm, setConfirm] = React.useState<
    IdentitySessionRow | "others" | null
  >(null);
  const [page, setPage] = React.useState(0);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groups = React.useMemo(
    () => (sessions === undefined ? [] : groupSessions(sessions)),
    [sessions],
  );
  if (sessions === undefined)
    return loading ? (
      <SecuritySectionSkeleton title={t("security.sessions")} />
    ) : null;
  const others =
    !everyone && groups.some((group) => group.sessions.some((s) => !s.current));
  const pageCount = Math.max(1, Math.ceil(groups.length / SESSION_PAGE_SIZE));
  // 退出几台之后页数变少：停在最后一页，而不是一页空表。
  const shownPage = Math.min(page, pageCount - 1);
  const visible = groups.slice(
    shownPage * SESSION_PAGE_SIZE,
    (shownPage + 1) * SESSION_PAGE_SIZE,
  );
  const columns = everyone ? 5 : 4;
  const toggle = (deviceId: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(deviceId)) next.add(deviceId);
      return next;
    });

  const revokeButton = (session: IdentitySessionRow, name: string) =>
    busy === session.sessionId ? (
      <Spinner
        className="ml-auto"
        aria-label={t("security.sessions.signOut")}
      />
    ) : session.current ? null : (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-destructive"
        disabled={busy !== null}
        aria-label={t("security.sessions.signOutNamed", { name })}
        onClick={() => setConfirm(session)}
      >
        {t("security.sessions.signOut")}
      </Button>
    );

  return (
    <SecuritySection
      title={t("security.sessions")}
      action={
        canSeeEveryone ? (
          <label className="flex items-center gap-2 text-meta text-muted-foreground">
            {t("security.sessions.everyone")}
            <Switch
              checked={everyone}
              aria-label={t("security.sessions.everyone")}
              onCheckedChange={onEveryone}
            />
          </label>
        ) : undefined
      }
    >
      <Card variant="table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("security.sessions.device")}</TableHead>
              {everyone && (
                <TableHead>{t("security.sessions.member")}</TableHead>
              )}
              <TableHead>{t("security.sessions.lastActive")}</TableHead>
              <TableHead>{t("security.sessions.ip")}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">
                  {t("security.sessions.signOut")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((group) => {
              const lead = group.sessions[0] as IdentitySessionRow;
              const Icon = platformIcon(lead.userAgent);
              const name = lead.deviceName || lead.deviceId.slice(0, 8);
              const many = group.sessions.length > 1;
              const open = many && expanded.has(group.deviceId);
              return (
                <React.Fragment key={group.deviceId}>
                  <TableRow data-slot="session-group">
                    <TableCell className="max-w-[18rem]">
                      <span className="flex min-w-0 items-center gap-2">
                        {many ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-expanded={open}
                            aria-label={t("security.sessions.expand", {
                              name,
                            })}
                            onClick={() => toggle(group.deviceId)}
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className={cn(
                                "transition-transform",
                                open && "rotate-90",
                              )}
                            />
                          </Button>
                        ) : (
                          <Icon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                        <span
                          className="truncate font-medium"
                          title={lead.userAgent}
                        >
                          {name}
                        </span>
                        {group.current && (
                          <Badge variant="secondary" size="sm">
                            {t("security.sessions.current")}
                          </Badge>
                        )}
                        {many && (
                          <Badge variant="outline" size="sm">
                            {t("security.sessions.count", {
                              count: group.sessions.length,
                            })}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    {everyone && (
                      <TableCell className="max-w-[10rem] truncate">
                        {names?.get(lead.principalId) ||
                          lead.principalId.slice(0, 8)}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground tabular-nums">
                      {when(group.lastActiveMs)}
                    </TableCell>
                    <TableCell className="font-mono text-meta text-muted-foreground">
                      {lead.remoteIp || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {many ? null : revokeButton(lead, name)}
                    </TableCell>
                  </TableRow>
                  {open &&
                    group.sessions.map((session) => {
                      const SessionIcon = platformIcon(session.userAgent);
                      return (
                        <TableRow
                          key={session.sessionId}
                          data-slot="session-row"
                        >
                          <TableCell className="max-w-[18rem]">
                            <span className="flex min-w-0 items-center gap-2 pl-8">
                              <SessionIcon
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-muted-foreground"
                              />
                              <span
                                className="truncate text-muted-foreground"
                                title={session.userAgent}
                              >
                                {name}
                              </span>
                              {session.current && (
                                <Badge variant="secondary" size="sm">
                                  {t("security.sessions.current")}
                                </Badge>
                              )}
                            </span>
                          </TableCell>
                          {everyone && <TableCell />}
                          <TableCell className="text-muted-foreground tabular-nums">
                            {when(lastActive(session))}
                          </TableCell>
                          <TableCell className="font-mono text-meta text-muted-foreground">
                            {session.remoteIp || "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {revokeButton(session, name)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </React.Fragment>
              );
            })}
            {visible.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={columns}
                  className="text-center text-muted-foreground"
                >
                  —
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      {(others || pageCount > 1) && (
        <div className="flex items-center justify-between gap-2">
          {others ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={busy !== null}
              onClick={() => setConfirm("others")}
            >
              {busy === "others" && (
                <Spinner aria-label={t("security.sessions.signOutOthers")} />
              )}
              {t("security.sessions.signOutOthers")}
            </Button>
          ) : (
            <span />
          )}
          {pageCount > 1 && (
            <Pagination
              aria-label={t("security.sessions.pages")}
              className="mx-0 w-auto justify-end"
            >
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text={t("security.sessions.previous")}
                    disabled={shownPage === 0}
                    onClick={() => setPage(shownPage - 1)}
                  />
                </PaginationItem>
                {paginationRange(shownPage, pageCount).map((index, position) =>
                  index === "gap" ? (
                    <PaginationItem key={`gap-${position}`}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={index}>
                      <PaginationLink
                        isActive={index === shownPage}
                        aria-label={t("security.sessions.page", {
                          page: index + 1,
                        })}
                        onClick={() => setPage(index)}
                      >
                        {index + 1}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNext
                    text={t("security.sessions.next")}
                    disabled={shownPage >= pageCount - 1}
                    onClick={() => setPage(shownPage + 1)}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      )}
      <ConfirmRemove
        open={confirm !== null}
        title={
          confirm === "others"
            ? t("security.sessions.signOutOthers")
            : t("security.sessions.signOut")
        }
        subject={
          confirm === null || confirm === "others"
            ? ""
            : confirm.deviceName || confirm.deviceId
        }
        action={t("security.sessions.signOut")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target === "others") onRevokeOthers();
          else if (target) onRevoke(target);
        }}
      />
    </SecuritySection>
  );
}

function lastActive(session: IdentitySessionRow): number {
  return session.lastSeenAtMs || session.createdAtMs;
}

/** 由 UA 猜个图标：手机、桌面浏览器，认不出的用地球。 */
export function platformIcon(userAgent: string) {
  if (/iPhone|iPad|Android|Mobile/i.test(userAgent)) return Smartphone;
  if (/Macintosh|Windows|Linux|X11|CrOS|Electron/i.test(userAgent))
    return Laptop;
  return Globe;
}

/** 锁定的账号（契约 §18.1，owner）：没有锁着的就不出现。 */
export function LockoutList({
  lockouts,
  names,
  busy,
  onUnlock,
}: {
  lockouts: readonly Lockout[] | undefined;
  names?: ReadonlyMap<string, string>;
  busy: string | null;
  onUnlock(lockout: Lockout): void;
}) {
  const t = useT();
  const when = useDateTime();
  if (!lockouts || lockouts.length === 0) return null;
  return (
    <SecuritySection title={t("security.lockouts")}>
      <Card variant="table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("security.sessions.member")}</TableHead>
              <TableHead>{t("security.lockouts.failures")}</TableHead>
              <TableHead>{t("security.lockouts.until")}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">{t("security.lockouts.unlock")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lockouts.map((lockout) => (
              <TableRow key={lockout.key}>
                <TableCell className="max-w-[16rem] truncate font-medium">
                  {names?.get(lockout.principalId) || lockout.principalId}
                </TableCell>
                <TableCell className="tabular-nums">
                  {lockout.failures}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {when(lockout.lockedUntilMs)}
                </TableCell>
                <TableCell className="text-right">
                  {busy === lockout.principalId ? (
                    <Spinner
                      className="ml-auto"
                      aria-label={t("security.lockouts.unlock")}
                    />
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => onUnlock(lockout)}
                    >
                      {t("security.lockouts.unlock")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </SecuritySection>
  );
}
