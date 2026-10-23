import * as React from "react";
import { ArrowLeft, Menu, MailWarning } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Alert } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { RouteLink } from "../RouteLink";
import type { RouteMatch } from "../router";
import { ConsoleNav } from "./ConsoleNav";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { UserMenu } from "./UserMenu";
import {
  visibleNav,
  type ConsoleTeam,
  type ConsoleUser,
  type NavArea,
} from "./model";

const WIDE = "(min-width: 1024px)";

/** ≥1024 是固定侧栏，更窄是顶栏加左侧抽屉（云端控制台 §4.5）。 */
function useWide(): boolean {
  return React.useSyncExternalStore(
    (callback) => {
      const media = window.matchMedia(WIDE);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

export interface ConsoleShellProps {
  readonly user: ConsoleUser;
  readonly teams: readonly ConsoleTeam[];
  readonly match: RouteMatch;
  /** 有运营范围：账号菜单里出现「运营后台」。 */
  readonly operator?: boolean;
  /** 「运营后台」菜单项的去处，缺省 `/ops`。 */
  readonly operatorHref?: string;
  /** 导航项上的待处理数（只画 >0 的）。 */
  readonly counts?: Readonly<Record<string, number>>;
  readonly onSignOut?: () => void;
  /** 重新发送验证邮件；没给就不画按钮。 */
  readonly onResendVerification?: () => Promise<void>;
  readonly children: React.ReactNode;
}

function areaOf(match: RouteMatch): NavArea {
  return match.area === "team" || match.area === "ops"
    ? match.area
    : "personal";
}

/** 侧栏本体：顶端空间（或运营标题）、导航、底部账号。抽屉与固定侧栏共用。 */
export function ConsoleSidebar({
  user,
  teams,
  match,
  operator,
  operatorHref,
  counts,
  onSignOut,
  onNavigate,
}: Omit<ConsoleShellProps, "children" | "onResendVerification"> & {
  onNavigate?: () => void;
}) {
  const t = useT();
  const area = areaOf(match);
  const team = teams.find((row) => row.slug === match.params.team);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1 p-3">
        {area === "ops" ? (
          <>
            <div className="flex h-(--row-h-table) items-center gap-2 px-2">
              <span className="min-w-0 truncate font-medium">
                {t("cloud.nav.ops")}
              </span>
              <Badge variant="outline">{t("cloud.shell.operator")}</Badge>
            </div>
            <Button
              asChild
              variant="ghost"
              className="justify-start gap-2 px-2 font-normal text-muted-foreground"
            >
              <RouteLink href="/" onClick={onNavigate}>
                <ArrowLeft aria-hidden />
                {t("cloud.shell.backToConsole")}
              </RouteLink>
            </Button>
          </>
        ) : (
          <SpaceSwitcher teams={teams} current={team?.slug ?? null} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ConsoleNav
          area={area}
          items={visibleNav(area, team?.role)}
          {...(team ? { teamSlug: team.slug } : {})}
          active={match.nav}
          {...(counts ? { counts } : {})}
          {...(onNavigate ? { onNavigate } : {})}
        />
      </div>
      <div className="border-t border-border p-3">
        <UserMenu
          user={user}
          {...(operator ? { operator } : {})}
          {...(operatorHref ? { operatorHref } : {})}
          {...(onSignOut ? { onSignOut } : {})}
        />
      </div>
    </div>
  );
}

/**
 * 控制台外壳（云端控制台 §2.1）：侧栏 240 / 顶栏 48 + 左抽屉 280，`<main id="main">`
 * 居中最宽 1080，第一个可聚焦元素是「跳到正文」。邮箱未验证时页头之上常驻一条提示。
 */
export function ConsoleShell(props: ConsoleShellProps) {
  const { children, onResendVerification, ...sidebarProps } = props;
  const { user, match } = sidebarProps;
  const t = useT();
  const wide = useWide();
  const [open, setOpen] = React.useState(false);
  const main = React.useRef<HTMLElement>(null);
  const [sent, setSent] = React.useState<"idle" | "sending" | "sent">("idle");

  // 换了页就收起抽屉。
  React.useEffect(() => setOpen(false), [match.id, match.params.team]);

  const resend = async () => {
    setSent("sending");
    try {
      await onResendVerification?.();
      setSent("sent");
    } catch {
      setSent("idle");
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground lg:flex-row">
      <a
        href="#main"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:start-3 focus-visible:top-3 focus-visible:z-50 focus-visible:rounded-card focus-visible:bg-card focus-visible:px-3 focus-visible:py-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        {t("cloud.shell.skip")}
      </a>
      {wide ? (
        <aside className="h-full w-60 shrink-0 border-e border-border bg-panel">
          <ConsoleSidebar {...sidebarProps} />
        </aside>
      ) : (
        <>
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-panel pt-[var(--safe-top)] ps-[max(0.5rem,var(--safe-left))] pe-[max(0.5rem,var(--safe-right))] box-content">
            <IconButton
              size="cluster"
              label={t("cloud.shell.openNav")}
              className="pointer-coarse:size-11"
              onClick={() => setOpen(true)}
            >
              <Menu />
            </IconButton>
            <div className="min-w-0 flex-1">
              <HeaderSpace {...sidebarProps} />
            </div>
            <UserMenu
              compact
              user={user}
              {...(props.operator ? { operator: true } : {})}
              {...(props.operatorHref
                ? { operatorHref: props.operatorHref }
                : {})}
              {...(props.onSignOut ? { onSignOut: props.onSignOut } : {})}
            />
          </header>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              aria-describedby={undefined}
              className="gap-0 bg-panel p-0 pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] data-[side=left]:w-[min(calc(280px+var(--safe-left)),calc(100vw-48px))]"
            >
              <SheetTitle className="sr-only">
                {t("cloud.shell.nav")}
              </SheetTitle>
              <ConsoleSidebar
                {...sidebarProps}
                onNavigate={() => setOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <main
          id="main"
          ref={main}
          tabIndex={-1}
          className="mx-auto flex w-full max-w-[1080px] flex-col px-4 pt-6 pb-[max(2rem,var(--safe-bottom))] outline-none md:px-6 lg:px-8"
        >
          {user.emailVerified ? null : (
            <Alert
              role="status"
              className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2"
            >
              <MailWarning aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {t("cloud.unverified.alert")}
              </span>
              {onResendVerification ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sent !== "idle"}
                  onClick={() => void resend()}
                >
                  {t(
                    sent === "sent"
                      ? "cloud.unverified.sent"
                      : "cloud.unverified.resend",
                  )}
                </Button>
              ) : null}
            </Alert>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}

/** 顶栏中间：当前空间（运营后台里是标题加徽标）。 */
function HeaderSpace(props: Omit<ConsoleShellProps, "children">) {
  const t = useT();
  if (props.match.area === "ops")
    return (
      <div className="flex items-center gap-2 px-2">
        <span className="truncate font-medium">{t("cloud.nav.ops")}</span>
        <Badge variant="outline">{t("cloud.shell.operator")}</Badge>
      </div>
    );
  return (
    <SpaceSwitcher
      teams={props.teams}
      current={
        props.teams.find((row) => row.slug === props.match.params.team)?.slug ??
        null
      }
    />
  );
}
