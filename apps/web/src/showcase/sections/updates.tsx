import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import {
  UpdateStatusNotes,
  UpdateStatusRows,
} from "@/panels/settings/pages/AboutPage";
import { ReleaseHistory } from "@/panels/settings/pages/about/ReleaseHistory";
import { ServerUpgradeNotice } from "@/panels/settings/pages/about/ServerUpgradeNotice";
import { AndroidUpdateGroup } from "@/panels/settings/pages/about/MobileUpdate";
import type { InstallApkStatus } from "@/mobile/native-bridge";
import { useT } from "@/app/preferences-store";
import { mergeUpdatesState } from "@/updates/state";
import { androidUpdate } from "@/updates/releases";
import { INSTALLED, RELEASES, UPDATE_STATES } from "../fixtures/updates";

const noop = () => undefined;

/** 展示页的安装按钮依次答这几种结果，四种反应都能点出来。 */
const INSTALL_SEQUENCE: InstallApkStatus[] = [
  "permissionRequired",
  "checksumMismatch",
  "failed",
  "started",
];
let installStep = 0;
const fakeInstall = async () => ({
  status: INSTALL_SEQUENCE[installStep++ % INSTALL_SEQUENCE.length]!,
});

/**
 * `updates` 分区（设计展示页 §2.1，设计系统 §5.14）：更新页的各种状态并排，
 * 加上版本历史（§64）、服务器升级命令与 Android 的下载并安装。每一格是真的
 * `mergeUpdatesState` 合并结果交给真的组件——与设置页同一份渲染，只是不连 store。
 */
export default function UpdatesSection() {
  const t = useT();
  const apk = androidUpdate(RELEASES.releases, INSTALLED);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {UPDATE_STATES.map(({ id, host, shell }) => {
          const view = mergeUpdatesState(host, shell);
          return (
            <div
              key={id}
              data-update-state={id}
              className="flex min-w-0 flex-col gap-2"
            >
              <SettingsGroup>
                <SettingsRow label={t("updates.version")}>
                  <span className="text-body tabular-nums text-muted-foreground">
                    {INSTALLED}
                  </span>
                </SettingsRow>
                <UpdateStatusRows
                  view={view}
                  installed={INSTALLED}
                  busy={view.state === "checking"}
                  notesUrl={
                    view.offer?.notesUrl || view.release?.notesUrl || ""
                  }
                  installerUrl={view.managed?.download?.url ?? ""}
                  onAction={noop}
                />
              </SettingsGroup>
              <UpdateStatusNotes view={view} />
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div
          data-update-state="history"
          className="flex min-w-0 flex-col gap-2"
        >
          <ReleaseHistory
            data={RELEASES}
            current={RELEASES.current}
            latest={RELEASES.latest}
            coolingDown
            onRefresh={noop}
            onOpen={noop}
            assets={(release) =>
              release.assets.filter((asset) => asset.name.endsWith(".dmg"))
            }
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div data-update-state="server" className="flex flex-col gap-2">
            <ServerUpgradeNotice version={RELEASES.latest ?? INSTALLED} />
          </div>
          {apk && (
            <div data-update-state="android" className="flex flex-col gap-2">
              <AndroidUpdateGroup update={apk} install={fakeInstall} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
