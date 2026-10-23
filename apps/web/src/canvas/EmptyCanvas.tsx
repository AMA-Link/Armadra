import { Plus, Terminal } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { useEnabledAgents } from "@/app/use-agents";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { commandKeysLabel } from "@/keybindings";
import { EmptyState } from "@/ui/state";
import { ADD_MENU_CONTENT_CLASS, AddMenuContent } from "./menus/AddMenuContent";
import { buildAddMenu } from "./menus/add-menu";
import { currentViewportCenter } from "./placement";

/**
 * 空画布的起点：画布上既没有节点也没有白板对象时，在正中是一张 `EmptyState`
 * （一句名词标题）加两个动作——「终端」（主按钮，带当前键位）与「添加」（完整的
 * 新建菜单，与 Dock 的 `+` 同一份 `AddMenuContent`）。「终端」直接跑菜单里
 * 「新建终端」那一项，落点与相机跟随和从菜单点完全一样。不写说明文字；放下
 * 第一个东西它就消失。
 */
export function EmptyCanvas() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const empty = useCanvasStore(
    (state) =>
      state.document !== null &&
      state.document.nodes.length === 0 &&
      state.whiteboard.items.length === 0,
  );
  const agents = useEnabledAgents();

  if (!workspace || !empty) return null;
  const terminalKeys = commandKeysLabel("canvas.newTerminal");

  return (
    <div
      data-slot="empty-canvas"
      className="pointer-events-none absolute inset-0 z-[var(--z-pills)] grid place-items-center"
    >
      <EmptyState
        title={t("emptyCanvas.title")}
        className="pointer-events-auto w-auto min-w-64 flex-none border-solid border-border-strong bg-panel/90 shadow-overlay backdrop-blur-[12px]"
      >
        <div className="flex items-center gap-2">
          <Button
            aria-label={t("add.terminal")}
            {...(terminalKeys ? { shortcut: terminalKeys } : {})}
            onClick={() =>
              buildAddMenu(agents, t)
                .find((item) => item.id === "add.terminal")
                ?.run({
                  addNode,
                  position: currentViewportCenter(),
                  workspace,
                  agents,
                })
            }
          >
            <Terminal data-icon="inline-start" />
            {t("emptyCanvas.terminal")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label={t("dock.add")}>
                <Plus data-icon="inline-start" />
                {t("emptyCanvas.add")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="center"
              className={cn("z-[var(--z-menu)]", ADD_MENU_CONTENT_CLASS)}
            >
              <AddMenuContent
                kind="dropdown"
                ctx={{
                  addNode,
                  position: currentViewportCenter(),
                  workspace,
                  agents,
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </EmptyState>
    </div>
  );
}
