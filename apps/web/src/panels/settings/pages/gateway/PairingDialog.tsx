import { useT } from "../../../../app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { PairingCard, type PairingCardProps } from "./PairingCard";

/**
 * 「手机扫码连接」（#675）：点开才铸配对码、才显示二维码；地址选择、新配对码、复制
 * 链接、指纹与 CA 下载都在 {@link PairingCard} 里。
 */
export function PairingDialog({
  open,
  onClose,
  ...card
}: PairingCardProps & { open: boolean; onClose(): void }) {
  const t = useT();
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[560px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("remote.scan")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <PairingCard {...card} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
