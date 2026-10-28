import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { RouteLink } from "../RouteLink";
import { navHref, type NavArea, type NavItem } from "./model";

/** 侧栏导航：设置页同款的项（行高 32、图标 16、选中 `--brand-soft` 底）；项是真链接。 */
export function ConsoleNav({
  area,
  items,
  teamSlug,
  active,
  counts,
  onNavigate,
}: {
  area: NavArea;
  items: readonly NavItem[];
  teamSlug?: string;
  active: string | null;
  /** 待处理数；只有 >0 才画。 */
  counts?: Readonly<Record<string, number>>;
  onNavigate?: () => void;
}) {
  const t = useT();
  return (
    <nav aria-label={t("cloud.shell.nav")} className="px-3 pb-3">
      <ul className="flex flex-col gap-0.5">
        {items.map((entry) => {
          const count = counts?.[entry.id] ?? 0;
          return (
            <li key={entry.id}>
              <Button
                asChild
                variant="ghost"
                className="w-full justify-start gap-2 px-2 font-normal text-muted-foreground aria-[current=page]:bg-brand-soft aria-[current=page]:text-foreground pointer-coarse:h-[44px]"
              >
                <RouteLink
                  href={navHref(area, entry, teamSlug)}
                  aria-current={entry.id === active ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <entry.icon aria-hidden />
                  <span className="min-w-0 truncate">{t(entry.labelKey)}</span>
                  {count > 0 ? (
                    <Badge variant="secondary" className="ms-auto tabular-nums">
                      {count}
                    </Badge>
                  ) : null}
                </RouteLink>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
