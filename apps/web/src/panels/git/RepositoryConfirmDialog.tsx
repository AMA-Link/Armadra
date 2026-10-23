import type { GitExpectedState, GitRepositoryAction } from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Checkbox } from "../../ui/checkbox";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { actionTarget, type Confirmation } from "./operations";

/**
 * 一次仓库写操作的确认框：复述将要发生的事和被比对的期望状态，强推这类不可逆
 * 动作还要第二次勾选。什么时候不能提交由调用方算好后传进来。
 */
export function RepositoryConfirmDialog({
  confirmation,
  setConfirmation,
  acknowledged,
  setAcknowledged,
  blocked,
  repositoryPath,
  submit,
}: {
  confirmation: Confirmation | null;
  setConfirmation: (value: Confirmation | null) => void;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  blocked: boolean;
  repositoryPath: string;
  submit: (input: {
    action: GitRepositoryAction;
    expected: GitExpectedState;
  }) => void;
}) {
  const t = useT();
  const lease =
    confirmation?.action.kind === "push"
      ? confirmation.action.forceWithLease
      : null;
  return (
    <ResponsiveAlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmation(null);
      }}
    >
      <ResponsiveAlertDialogContent
        aria-describedby={undefined}
        className="max-h-[90dvh] overflow-y-auto"
      >
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>
            {confirmation
              ? t("gitRepo.confirmAction", {
                  action:
                    confirmation.action.kind === "reset"
                      ? `${t("gitRepo.reset")} · ${confirmation.action.mode}`
                      : t(`gitRepo.${confirmation.action.kind}`),
                })
              : t("gitRepo.confirmTitle")}
          </ResponsiveAlertDialogTitle>
        </ResponsiveAlertDialogHeader>
        {confirmation && (
          <dl className="space-y-2 break-all text-meta">
            {confirmation.review && (
              <div>
                <dt className="text-muted-foreground">
                  {t("gitIntegration.commitOid")}
                </dt>
                <dd className="font-mono">{confirmation.review.oid}</dd>
                {confirmation.review.mainline && (
                  <dd>
                    {t("gitIntegration.mainline")}:{" "}
                    {confirmation.review.mainline}
                    {confirmation.review.parentOid && (
                      <span className="font-mono">
                        {" "}
                        · {confirmation.review.parentOid}
                      </span>
                    )}
                  </dd>
                )}
              </div>
            )}
            {confirmation.action.kind === "startCherryPick" && (
              <div>
                <dd>
                  {confirmation.action.recordOrigin ? "✓ " : "— "}
                  {t("gitIntegration.recordOrigin")}
                </dd>
                {confirmation.action.mainline && (
                  <dd>
                    {t("gitIntegration.mainline")}:{" "}
                    {confirmation.action.mainline}
                  </dd>
                )}
              </div>
            )}
            {confirmation.action.kind === "revert" &&
              confirmation.action.mainline && (
                <div>
                  <dd>
                    {t("gitIntegration.mainline")}:{" "}
                    {confirmation.action.mainline}
                  </dd>
                </div>
              )}
            {confirmation.action.kind === "sync" && (
              <div>
                <dt className="text-muted-foreground">
                  {t("gitRepo.remoteOid")}
                </dt>
                <dd className="font-mono">
                  {confirmation.action.expectedRemoteOid ??
                    t("gitRepo.remoteBranchMissing")}
                </dd>
              </div>
            )}
            {lease && (
              <div className="space-y-1 rounded-control border border-destructive p-2">
                <dt className="text-muted-foreground">
                  {t("gitRepo.leaseReplaces")}
                </dt>
                <dd className="font-mono">{lease.expectedRemoteOid}</dd>
                <dd>
                  <label className="flex items-center gap-2 py-1">
                    <Checkbox
                      checked={acknowledged}
                      onCheckedChange={(next) => setAcknowledged(next === true)}
                    />
                    {t("gitRepo.leaseAcknowledge")}
                  </label>
                </dd>
              </div>
            )}
            {confirmation.action.kind === "createStash" && (
              <div>
                <dd>
                  {confirmation.action.includeUntracked ? "✓ " : "— "}
                  {t("gitStash.includeUntracked")}
                </dd>
              </div>
            )}
            {(confirmation.action.kind === "applyStash" ||
              confirmation.action.kind === "popStash") && (
              <div>
                <dd>
                  {confirmation.action.reinstateIndex ? "✓ " : "— "}
                  {t("gitStash.reinstateIndex")}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">
                {t("gitRepo.repository")}
              </dt>
              <dd>{repositoryPath}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("gitRepo.target")}</dt>
              <dd>{actionTarget(confirmation.action)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("gitRepo.head")}</dt>
              <dd>
                {confirmation.expected.branch ?? t("gitRepo.detached")} ·{" "}
                {confirmation.expected.headOid ?? t("gitRepo.unborn")}
              </dd>
            </div>
          </dl>
        )}
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>
            {t("gitRepo.cancel")}
          </ResponsiveAlertDialogCancel>
          <ResponsiveAlertDialogAction
            variant={lease ? "destructive-solid" : "default"}
            disabled={blocked || (Boolean(lease) && !acknowledged)}
            onClick={() => {
              if (confirmation && !blocked && (!lease || acknowledged)) {
                submit(confirmation);
                setConfirmation(null);
              }
            }}
          >
            {t(lease ? "gitRepo.confirmForce" : "gitRepo.confirm")}
          </ResponsiveAlertDialogAction>
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  );
}
