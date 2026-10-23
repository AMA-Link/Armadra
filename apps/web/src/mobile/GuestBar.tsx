import * as React from "react";

import { usePreferencesStore, useT } from "../app/preferences-store";
import { hostedRelay } from "../sources/hosted";
import { Button } from "@/ui/button";

/** 装 Armadra 的地方（官网）。 */
export const INSTALL_URL = "https://armadra.com/";

const ROLES = new Set(["viewer", "editor", "operator", "driver"]);

/**
 * 浏览器里按分享链接进来的访客：顶部一条窄栏，写主人（知道才写）、名字、权限与
 * 到期，右侧「安装 Armadra」。账号登录的页面、手机 App 与桌面都不出现。
 */
export function GuestBar() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const share = hostedRelay()?.guest() ?? null;
  if (share === null) return null;
  const title = share.ownerName
    ? t("links.bar.of", { owner: share.ownerName, name: share.name })
    : share.name || t("links.bar.shared");
  const meta = [
    ROLES.has(share.role) ? t(`sharing.role.${share.role}`) : "",
    share.expiresAtMs > 0
      ? t("links.bar.until", {
          time: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
            share.expiresAtMs,
          ),
        })
      : "",
  ].filter(Boolean);
  return (
    <div
      data-slot="guest-bar"
      className="flex min-h-8 items-center gap-3 border-b bg-background px-3 pt-[var(--safe-top)] text-caption"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{title}</span>
        {meta.length > 0 && (
          <span className="text-muted-foreground"> · {meta.join(" · ")}</span>
        )}
      </span>
      <Button asChild size="sm" variant="outline">
        <a href={INSTALL_URL} target="_blank" rel="noreferrer">
          {t("links.bar.install")}
        </a>
      </Button>
    </div>
  );
}

/** 访客页面把画布放进一栏高度固定的列，让出顶栏；其余页面原样。 */
export function GuestFrame({ children }: { children: React.ReactNode }) {
  const guest = hostedRelay()?.guest() != null;
  if (!guest) return <>{children}</>;
  return (
    <div className="flex h-dvh flex-col">
      <GuestBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
