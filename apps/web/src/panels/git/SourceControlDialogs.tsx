// 抽屉里两个「先问一次」的对话框：新建仓库，以及还原一个文件。两者都会丢掉
// 工作，所以都由调用方给出确认后的动作，这里只负责问清楚丢的是什么。
import type { GitRestoreSource } from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";

/** 待还原的文件：属于哪个仓库、是不是未跟踪，决定问法与可选动作。 */
export type RestoreTarget = {
  path: string;
  untracked: boolean;
  repository: string;
};

export function SourceControlDialogs({
  confirmInit,
  setConfirmInit,
  init,
  restore,
  setRestore,
  revert,
}: {
  confirmInit: boolean;
  setConfirmInit: (next: boolean) => void;
  init: () => void;
  restore: RestoreTarget | null;
  setRestore: (next: RestoreTarget | null) => void;
  revert: (input: {
    path: string;
    source: GitRestoreSource;
    repository: string;
  }) => void;
}) {
  const t = useT();
  return (
    <>
      <ResponsiveAlertDialog
        open={confirmInit}
        onOpenChange={(next) => {
          if (!next) setConfirmInit(false);
        }}
      >
        <ResponsiveAlertDialogContent aria-describedby={undefined}>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("scm.initTitle")}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("scm.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              onClick={() => {
                setConfirmInit(false);
                init();
              }}
            >
              {t("scm.initConfirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>

      {/*
       * Restoring from the index and restoring from HEAD lose different work,
       * so they are two labelled actions rather than one “revert” whose
       * effect the user has to guess.
       */}
      <ResponsiveAlertDialog
        open={restore !== null}
        onOpenChange={(next) => {
          if (!next) setRestore(null);
        }}
      >
        <ResponsiveAlertDialogContent aria-describedby={undefined}>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("scm.revertTitle", { path: restore?.path ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("scm.cancel")}
            </ResponsiveAlertDialogCancel>
            {restore?.untracked ? (
              <ResponsiveAlertDialogAction
                variant="destructive-solid"
                onClick={() => {
                  if (restore)
                    revert({
                      path: restore.path,
                      source: "index",
                      repository: restore.repository,
                    });
                  setRestore(null);
                }}
              >
                {t("scm.restoreDelete")}
              </ResponsiveAlertDialogAction>
            ) : (
              (["index", "head"] as const).map((source) => (
                <ResponsiveAlertDialogAction
                  key={source}
                  variant={source === "head" ? "destructive-solid" : "default"}
                  onClick={() => {
                    if (restore)
                      revert({
                        path: restore.path,
                        source,
                        repository: restore.repository,
                      });
                    setRestore(null);
                  }}
                >
                  {t(
                    source === "index"
                      ? "scm.restoreFromIndex"
                      : "scm.restoreFromHead",
                  )}
                </ResponsiveAlertDialogAction>
              ))
            )}
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
