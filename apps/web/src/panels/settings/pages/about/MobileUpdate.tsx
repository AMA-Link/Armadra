import * as React from "react";
import type { Release } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import type {
  InstallApkResult,
  InstallApkStatus,
} from "../../../../mobile/native-bridge";
import type { AndroidUpdate } from "../../../../updates/releases";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";

/**
 * Android：有更新的签名 APK 时「下载并安装」，交给原生 `installApk`（#288 §4）。
 *
 * - `started`：系统安装器已拉起，之后的事归系统；
 * - `permissionRequired`：设置页已打开，授权后再按一次（原生复用已核对的包）；
 * - `checksumMismatch` / `failed`：错误，可再试。
 */
export function AndroidUpdateGroup({
  update,
  install,
}: {
  update: AndroidUpdate;
  install: (url: string, sha256: string) => Promise<InstallApkResult>;
}) {
  const t = useT();
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<InstallApkStatus | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      setStatus((await install(update.url, update.sha256)).status);
    } finally {
      setBusy(false);
    }
  };

  const failed = status === "checksumMismatch" || status === "failed";
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label={t("updates.newVersion", { version: update.release.version })}
        >
          <Button
            size="sm"
            className="min-h-10"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy && <Spinner aria-hidden />}
            {t(
              status === null || status === "started"
                ? "updates.android.install"
                : "updates.action.retry",
            )}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      {failed ? (
        <Alert variant="destructive" data-slot="apk-install-failed">
          <AlertTitle className="font-normal">
            {t(`updates.android.${status}`)}
          </AlertTitle>
        </Alert>
      ) : (
        status !== null && (
          <p
            role="status"
            className="text-[13px] leading-5 text-muted-foreground"
          >
            {t(`updates.android.${status}`)}
          </p>
        )
      )}
    </>
  );
}

/** iOS（与没有 APK 的 Android）：只报新版本，给发布说明的链接。 */
export function MobileReleaseNotice({
  release,
  onOpen,
}: {
  release: Release;
  onOpen: (url: string) => void;
}) {
  const t = useT();
  return (
    <SettingsGroup>
      <SettingsRow
        label={t("updates.newVersion", { version: release.version })}
      >
        <Button
          size="sm"
          variant="secondary"
          className="min-h-10"
          onClick={() => onOpen(release.url)}
        >
          {t("updates.action.notes")}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
