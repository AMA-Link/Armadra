import { Ellipsis, ShieldUser } from "lucide-react";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import type { Locale } from "@/i18n";
import { LOCALES } from "@/i18n";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  THEME_PREFERENCES,
  type ThemePreference,
} from "@/app/preferences-store";
import { navigate } from "../router";
import type { ConsoleUser } from "./model";

/** 账号菜单：主题、语言、运营后台（只对运营范围）、退出登录。 */
export function UserMenu({
  user,
  operator,
  operatorHref = "/ops",
  compact,
  onSignOut,
}: {
  user: ConsoleUser;
  operator?: boolean;
  /** 「运营后台」去哪：有运营会话是 `/ops`，只有运营范围时是运营登录。 */
  operatorHref?: string;
  /** 窄屏顶栏：只有头像。 */
  compact?: boolean;
  onSignOut?: () => void;
}) {
  const t = useT();
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const locale = usePreferencesStore((state) => state.locale);
  const setLocale = usePreferencesStore((state) => state.setLocale);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("cloud.user.menu")}
            className="pointer-coarse:size-11"
          >
            <UserAvatar name={user.name} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="lg"
            className="w-full justify-start gap-2 px-2"
          >
            <UserAvatar name={user.name} />
            <span className="min-w-0 truncate" translate="no">
              {user.name}
            </span>
            <Ellipsis aria-hidden className="ms-auto text-muted-foreground" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={compact ? "end" : "start"}
        side={compact ? "bottom" : "top"}
        className="min-w-56"
      >
        <DropdownMenuLabel className="truncate font-normal" translate="no">
          {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {operator ? (
          <DropdownMenuItem onSelect={() => navigate(operatorHref)}>
            <ShieldUser aria-hidden />
            {t("cloud.nav.ops")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t("settings.theme")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as ThemePreference)}
            >
              {THEME_PREFERENCES.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {t(`settings.theme.${value}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("settings.locale")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={locale}
              onValueChange={(value) => setLocale(value as Locale)}
            >
              {LOCALES.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {t(`settings.locale.${value}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onSignOut ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              {t("cloud.user.signOut")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserAvatar({ name }: { name: string }) {
  return (
    <Avatar size="sm">
      <AvatarFallback className="font-medium text-foreground">
        {[...name][0]}
      </AvatarFallback>
    </Avatar>
  );
}
