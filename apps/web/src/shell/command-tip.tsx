import type { ComponentProps } from "react";

import { commandKeysLabel, type CommandId } from "@/keybindings";
import { TooltipContent } from "@/ui/tooltip";

/**
 * Dock / 工具簇上每个钮的提示：文案 + 该命令当前生效的键位（`Kbd`）。
 * 键位从命令表读（用户改键后跟着变），没有键位或快捷键总开关关着时只显示文案。
 */
export function CommandTip({
  label,
  command,
  ...props
}: Omit<ComponentProps<typeof TooltipContent>, "children" | "shortcut"> & {
  label: string;
  command?: CommandId | undefined;
}) {
  const keys = command === undefined ? "" : commandKeysLabel(command);
  return (
    <TooltipContent {...(keys ? { shortcut: keys } : {})} {...props}>
      {label}
    </TooltipContent>
  );
}
