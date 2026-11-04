import { useT } from "../../../../app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { PairingCard, type PairingCardProps } from "./PairingCard";

/**
 * 「连接手机」（#675、#749）：点开才铸二维码；新配对码、复制链接、指纹与 CA 下载都在
 * {@link PairingCard} 里。
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
