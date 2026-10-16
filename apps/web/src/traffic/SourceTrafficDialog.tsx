import { useT } from "../app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { SourceTraffic } from "./SourceTraffic";

export interface SourceTrafficTarget {
  readonly sourceId: string;
  readonly name: string;
}

/**
 * 桌面远程访问页的入口：我经中继访问某台电脑用了多少（设计 §6.4）。内容与手机
 * 连接页是同一段 {@link SourceTraffic}，数据来自这台客户端自己的计量。
 */
export function SourceTrafficDialog({
  target,
  onClose,
}: {
  readonly target: SourceTrafficTarget | null;
  readonly onClose: () => void;
}) {
  const t = useT();
  return (
    <ResponsiveDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent
        data-slot="source-traffic-dialog"
        className="z-[var(--z-dialog)] sm:max-w-[420px]"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("traffic.open", { name: target?.name ?? "" })}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {target !== null && (
          <SourceTraffic sourceId={target.sourceId} name={target.name} />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
