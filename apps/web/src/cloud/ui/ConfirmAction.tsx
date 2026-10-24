import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";

export interface ConfirmActionProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 标题复述对象（「撤销「周报」？」），由调用方经 i18n 给出。 */
  readonly title: string;
  /** 确认按钮复述后果（「撤销链接」），不用「确定」。 */
  readonly actionLabel: string;
  /** 后果的一行（「已加入的人一并停用」）；不是说明。 */
  readonly consequence?: string;
  /** 确认依赖的数据还没到时为 true：确认按钮转圈并不可点。 */
  readonly pending?: boolean;
  /** 确认依赖的数据取失败时给：确认按钮换成「重试」，不永远转圈。 */
  readonly onRetry?: () => void;
  /** 重试在途时为 true：「重试」按钮转圈，不可再点。 */
  readonly retrying?: boolean;
  /** 抛错时对话框留着，失败的提示归调用方（sonner）。 */
  readonly onConfirm: () => void | Promise<void>;
}

/** 不需要输入对象名的危险确认（云端控制台 §4.3）：撤销访问 / 链接 / 邀请、退出设备。 */
export function ConfirmAction({
  open,
  onOpenChange,
  title,
  actionLabel,
  consequence,
  pending = false,
  onRetry,
  retrying = false,
  onConfirm,
}: ConfirmActionProps) {
  const t = useT();
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      /* 对话框留着，可以重试。 */
    } finally {
      setBusy(false);
    }
  };
  return (
    <ResponsiveAlertDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveAlertDialogContent aria-describedby={undefined}>
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>{title}</ResponsiveAlertDialogTitle>
        </ResponsiveAlertDialogHeader>
        {consequence ? (
          <p className="text-body whitespace-pre-line">{consequence}</p>
        ) : null}
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>
            {t("cloud.common.cancel")}
          </ResponsiveAlertDialogCancel>
          {onRetry ? (
            <Button variant="outline" loading={retrying} onClick={onRetry}>
              {t("cloud.common.retry")}
            </Button>
          ) : (
            <Button
              variant="destructive-solid"
              loading={busy || pending}
              onClick={() => void run()}
            >
              {actionLabel}
            </Button>
          )}
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  );
}
