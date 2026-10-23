import { Check, ChevronsUpDown, UserRound } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { memberColorVar } from "@/ui/member-dot";
import { navigate, spacePath } from "../router";
import type { ConsoleTeam } from "./model";

/** 团队按地址取一个稳定的成员色（1–8）。 */
function colorIndex(slug: string): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
}

function SpaceAvatar({ team }: { team?: ConsoleTeam }) {
  return (
    <Avatar size="sm">
      <AvatarFallback
        style={
          team
            ? ({
                "--space-color": memberColorVar(colorIndex(team.slug)),
              } as React.CSSProperties)
            : undefined
        }
        className={
          team
            ? "bg-[color-mix(in_srgb,var(--space-color)_22%,transparent)] font-medium text-foreground"
            : undefined
        }
      >
        {team ? (
          [...team.name][0]
        ) : (
          <UserRound aria-hidden className="size-3.5" />
        )}
      </AvatarFallback>
    </Avatar>
  );
}

/** 空间切换：个人空间、各团队；选中写进地址（云端控制台 §2.2）。 */
export function SpaceSwitcher({
  teams,
  current,
}: {
  teams: readonly ConsoleTeam[];
  /** 当前团队地址；个人空间是 `null`。 */
  current: string | null;
}) {
  const t = useT();
  const team = teams.find((row) => row.slug === current);
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="lg"
          className="w-full justify-start gap-2 px-2"
        >
          <SpaceAvatar {...(team ? { team } : {})} />
          <span className="min-w-0 truncate font-medium">
            {team ? team.name : t("cloud.space.personal")}
          </span>
          <ChevronsUpDown
            aria-hidden
            className="ms-auto text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={t("cloud.space.switch")}
        className="min-w-56"
      >
        <DropdownMenuItem onSelect={() => navigate(spacePath("me"))}>
          <SpaceAvatar />
          {t("cloud.space.personal")}
          {team ? null : <Check aria-hidden className="ms-auto" />}
        </DropdownMenuItem>
        {sorted.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("cloud.space.teams")}</DropdownMenuLabel>
            {sorted.map((row) => (
              <DropdownMenuItem
                key={row.slug}
                onSelect={() => navigate(spacePath({ team: row.slug }))}
              >
                <SpaceAvatar team={row} />
                <span className="min-w-0 truncate">{row.name}</span>
                {row.slug === current ? (
                  <Check aria-hidden className="ms-auto" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
