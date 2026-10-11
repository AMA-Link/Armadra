import { Notification, app } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { IPC } from "../../shared/ipc";
import { localeFromTag } from "../../shell-core/messages";
import { dataDir } from "../../shell-core/paths";
import type { Locale, Staged } from "../../shell-core/updates/notify";
import type { DesktopLifecycle } from "../lifecycle";
import {
  type RuntimeProcess,
  ownedRuntimeAddress,
  socketHealth,
} from "../runtime-process";
import { markQuitting } from "../window";
import { defaultInstallers } from "./install";
import { UpdatesController, type UpdatesDeps } from "./updater";

/**
 * The updater's assembly: one call from `main/index.ts`, and the seven
 * handlers it contributes to the IPC table.
 *
 * Everything the updater is allowed to do to the rest of the shell goes
 * through `UpdatesDeps`, so `updater.ts` never reaches into the Host or the
 * Runtime directly and can be exercised with stand-ins.
 */

export { UpdatesController } from "./updater";

let controller: UpdatesController | null = null;

export interface UpdatesAssembly {
  readonly handlers: Record<string, (...args: unknown[]) => unknown>;
  /**
   * The staged-update announcement, for the tray: subscribe, show "restart to
   * finish updating" while `ready` and `installable`, and call `install` when
   * it is pressed — the same restart the settings page runs.
   */
  readonly onStaged: (listener: (staged: Staged) => void) => () => void;
  /** `updates:install`, for the tray item. */
  readonly install: () => Promise<unknown>;
}

/** One system notification, when the platform draws them. */
export function showNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch {
    // Best-effort: the settings page and the tray say the same thing.
  }
}

/** The notification's language: the system UI's, as the tray reads it. */
export function notificationLocale(): Locale {
  return localeFromTag(app.getLocale()) === "zh-CN" ? "zhCn" : "en";
}

export function installUpdates(
  lifecycle: DesktopLifecycle,
  runtime: RuntimeProcess,
  overrides: Partial<UpdatesDeps> = {},
): UpdatesAssembly {
  const deps: UpdatesDeps = {
    // 壳不再拉起任何独立的后台进程：core 就是全部，它由 `runtime.stop()` 停。
    runtime: { stop: () => runtime.stop() },
    runtimeVersion: async () =>
      (await socketHealth(ownedRuntimeAddress()))?.version ?? null,
    // `quitAndInstall()` closes every window and only then calls `app.quit()`.
    // The window's own `close` handler hides it while the app is not quitting,
    // so without this flip the window merely hides and the install never runs.
    onBeforeRestart: markQuitting,
    // core 写的 `<data dir>/settings.json`：`updates.channel`、`updates.autoCheck`、
    // `updates.notify` 都在这份文档里。读不到就是默认值（stable、自动检查、通知）。
    settings: () => readFile(join(dataDir(), "settings.json")),
    // 「更新已下载」的系统通知（`updates.notify` 关掉时不发），语言跟系统界面。
    notify: showNotification,
    locale: notificationLocale,
    // 未签名包的安装路径最后一步是退出，由辅助脚本 / 安装器接手。
    installers: defaultInstallers(() => app.quit()),
    ...overrides,
  };
  const updates = new UpdatesController(deps);
  controller = updates;
  // 自动检查：启动后约一分钟一次，之后每六小时以上（带抖动）。本地构建与没配置
  // 发布源的构建在 `checkRelease` 里第一步就返回，不碰网络。
  // 定时器 unref 过，不会拖住退出。
  updates.startSchedule();
  return {
    handlers: {
      [IPC.updatesState.channel]: () => updates.state(),
      // 页面带着一份 Host 答复来时照旧交叉核对它；什么都没带就是「现在检查」，
      // 由壳自己去问发布索引。
      [IPC.updatesCheck.channel]: (verdict: unknown) =>
        verdict === undefined || verdict === null
          ? updates.checkRelease({ manual: true })
          : updates.check(verdict),
      [IPC.updatesDismiss.channel]: () => updates.dismiss(),
      [IPC.updatesCancel.channel]: () => updates.cancel(),
      [IPC.updatesDownload.channel]: () => updates.download(),
      [IPC.updatesInstall.channel]: () => updates.install(),
      [IPC.updatesRestartReport.channel]: () => updates.restartReport(),
    },
    onStaged: (listener) => updates.onStaged(listener),
    install: () => updates.install(),
  };
}

/** The controller, once assembled. `null` before startup, and in tests. */
export function updatesController(): UpdatesController | null {
  return controller;
}
