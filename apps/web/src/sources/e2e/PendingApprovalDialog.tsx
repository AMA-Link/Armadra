import * as React from "react";

import { useT } from "../../app/preferences-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { pendingApprovals } from "./manager";

/** 「482913」→「482 913」：分两组读得清。 */
export function groupedSas(sas: string): string {
  return sas.length === 6 ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;
}

/**
 * 新设备这一侧（契约 §77）：等那台电脑的主人核对。中间是握手推出来的 6 位校验码，
 * 主人在那台电脑上输入同一串数字后放行；中间人两侧的校验码必然不同。
 */
export function PendingApprovalDialog() {
  const t = useT();
  const items = React.useSyncExternalStore(
    pendingApprovals.subscribe,
    pendingApprovals.snapshot,
  );
  const current = items[0];
  if (current === undefined) return null;
  const rejected = current.status === "rejected";
  const close = () =>
    rejected ? pendingApprovals.dismiss(current.sourceId) : current.cancel();
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="sm:max-w-sm"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {current.label
              ? t("e2e.pending.title", { name: current.label })
              : t("e2e.pending.titleUnnamed")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {rejected ? (
          <Alert variant="destructive">
            <AlertTitle>{t("e2e.pending.rejected")}</AlertTitle>
          </Alert>
        ) : (
          <p
            className="py-2 text-center font-mono text-display font-medium tabular-nums tracking-[0.2em]"
            aria-live="polite"
          >
            {groupedSas(current.sas)}
          </p>
        )}
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {rejected ? t("e2e.pending.close") : t("e2e.pending.cancel")}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
