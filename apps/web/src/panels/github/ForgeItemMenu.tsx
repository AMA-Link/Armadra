import * as React from "react";
import { LayoutDashboard } from "lucide-react";

import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { toast } from "@/ui/toast";
import { copyText } from "@/acp/copy";
import { useT } from "@/app/preferences-store";
import { openExternal } from "@/platform";
import type { ForgeRepo } from "../../api/forge";
import { addForgeItemToCanvas, useCanAddToCanvas } from "./add-to-canvas";

/** 只放行 http(s) 的链接：远端给的地址是别人写的材料。 */
function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * 列表行的右键菜单：加到画板、打开详情、在浏览器中打开、复制链接。面板与画布节点里
 * 的行都是它。
 */
export function ForgeItemMenu({
  repo,
  kind,
  number,
  url,
  onOpen,
  children,
}: {
  repo: ForgeRepo;
  kind: "issue" | "pull";
  number: number;
  url: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const canAdd = useCanAddToCanvas();
  const link = safeUrl(url);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="min-w-0">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!canAdd}
          onSelect={() => addForgeItemToCanvas(repo, kind, number)}
        >
          {t("forge.menu.addToCanvas")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onOpen}>
          {t("forge.menu.open")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!link}
          onSelect={() => link && void openExternal(link)}
        >
          {t("forge.openRemote")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!link}
          onSelect={() =>
            link &&
            void copyText(link).then((done) => {
              if (done) toast.success(t("forge.menu.copied"));
            })
          }
        >
          {t("forge.menu.copyLink")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 详情头部的「加到画板」。 */
export function AddToCanvasButton({
  repo,
  kind,
  number,
}: {
  repo: ForgeRepo;
  kind: "issue" | "pull";
  number: number;
}) {
  const t = useT();
  const canAdd = useCanAddToCanvas();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!canAdd}
      data-slot="forge-add-to-canvas"
      onClick={() => addForgeItemToCanvas(repo, kind, number)}
    >
      <LayoutDashboard data-icon="inline-start" />
      {t("forge.menu.addToCanvas")}
    </Button>
  );
}
