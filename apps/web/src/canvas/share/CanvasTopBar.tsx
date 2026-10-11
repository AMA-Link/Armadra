import { PresenceBar } from "@/canvas/PresenceBar";
import {
  SharedWorkspaceBar,
  useSharedWorkspaceOpen,
} from "@/canvas/SharedWorkspaceBar";
import { noDragProps } from "@/shell/window-region";

/**
 * 画布右上、工具簇左边的一排（#301 B5）：打开的是别人分享来的工作空间时，先是
 * 「<主人> 的 <工作空间> · <权限>」与在线成员，后面是设备条。都不画时这一排
 * 一个像素都不占。
 */
export function CanvasTopBar() {
  const shared = useSharedWorkspaceOpen();
  return (
    <div
      data-slot="canvas-top-bar"
      {...noDragProps()}
      className="pointer-events-none absolute top-[14px] right-[60px] z-[var(--z-cluster)] flex items-center gap-2 *:pointer-events-auto"
    >
      {shared && (
        <SharedWorkspaceBar className="h-[38px] rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 px-2.5 shadow-[var(--shadow-pill)] backdrop-blur-[12px]" />
      )}
      <PresenceBar className="static" />
    </div>
  );
}
