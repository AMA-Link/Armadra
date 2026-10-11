import { app } from "electron";
import type { CancellationToken } from "electron-updater";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { IPC } from "../../shared/ipc";
import { dataDir } from "../../shell-core/paths";
import {
  initialState,
  installPath,
  installRefusal,
  requiresDetachedSignature,
  shouldEnableUpdater,
  type InstallPath,
  type UpdaterEnvironment,
} from "../../shell-core/updates/availability";
import {
  appBundleOf,
  assetNameOf,
  stagedFileName,
} from "../../shell-core/updates/install-plan";
import { managedDownload } from "../../shell-core/updates/managed";
import {
  SIGNATURE_LIMIT_BYTES,
  verifyDetached,
} from "../../shell-core/updates/minisign";
import { Cancellation } from "../../shell-core/updates/cancel";
import * as coordinate from "../../shell-core/updates/coordinate";
import {
  Machine,
  type Event,
  type Offer,
  type Reason,
  type UpdateState,
} from "../../shell-core/updates/machine";
import {
  STAGED_EVENT,
  type Locale,
  localeFromEnvironment,
  notificationBody,
  notificationTitle,
  stagedCleared,
  stagedReady,
  unsignedNotificationBody,
  wantsNotification,
  type Staged,
} from "../../shell-core/updates/notify";
import * as offer from "../../shell-core/updates/offer";
import {
  readVerdict,
  reasonFor,
  type HostVerdict,
} from "../../shell-core/updates/verdict";
import { sendToWindow } from "../window";
import {
  allowInsecureLoopback,
  currentTarget,
  releaseSource,
  updaterEnvironment,
} from "./environment";
import { defaultInstallers, type Installers } from "./install";

/**
 * Shell-side application updates, on electron-updater
 * (design docs/design/updates-and-service-install.md §2, migration §5 W2.2).
 *
 * The shell can only report what it could actually verify. electron-updater
 * refuses to install a package whose platform signature does not check out —
 * so an unsigned build could check nothing, and it says exactly that. It never
 * reports "up to date" for a check it did not make, and it never installs
 * anything on its own: the handlers below read, stage and, only after a person
 * confirms, restart.
 *
 * The work is split so the rules can be tested without a window — everything
 * with a rule worth stating lives in `shell-core/updates/`:
 *
 * - `machine` is the state machine, pure;
 * - `offer` turns the Host's answer plus the release manifest into one offer;
 * - `cancel` is the shell's own handle on a transfer already running;
 * - `notify` holds the two out-of-page announcements and their strings;
 * - `coordinate` decides what may be stopped and whether a restart worked;
 * - `availability` decides which installer runs (`installPath`), `minisign`
 *   verifies each bundle's `<asset>.sig`, `managed` names packages the shell
 *   must not replace;
 * - `main/updates/install.ts` is the unsigned installers' process work;
 * - this file is the Electron surface: the seven handlers and one event.
 *
 * Every downloaded bundle passes two independent checks before it is staged
 * (issue #288 §2): its sha256 equals the digest GitHub computed on upload, and,
 * whenever the package carries the release key, its `<asset>.sig` verifies
 * with that key. A platform-signed package then installs through
 * electron-updater; an unsigned macOS one through a helper script that replaces
 * the `.app` after this process exits; an unsigned Windows one by re-running
 * the NSIS installer silently.
 *
 * Two Electron rules are obeyed here rather than remembered:
 *
 *   1. **The window is resolved at send time** (`sendToWindow`), never
 *      captured in a closure. A download can finish long after a
 *      close→dock-reopen, and a captured reference is a destroyed window.
 *      Sending through that reference can crash the updater.
 *   2. **Only what this shell started is stopped** before an install — the
 *      in-process Runtime — and a Runtime that will not stop means the install
 *      never starts. That is `hostStopFailed`, which blocks installation.
 */

/** What the updater needs from the rest of the shell. */
export interface UpdatesDeps {
  /** Stops the Runtime this shell owns. */
  readonly runtime: { stop(): Promise<void> };
  /** The Runtime's own version, for the restart report. `null` if unreachable. */
  readonly runtimeVersion: () => Promise<string | null>;
  /**
   * Run immediately before `quitAndInstall()`. Required so the caller can flip
   * its "quitting" flag: `quitAndInstall()` closes every window and only then
   * calls `app.quit()`, but the window's own `close` handler hides it while
   * the app is not quitting — so without this the window merely hides,
   * `app.quit()` never fires, and the update never installs.
   */
  readonly onBeforeRestart: () => void;
  /** The Runtime's settings document, for `updates.notify`. */
  readonly settings: () => Promise<Uint8Array | string>;
  /** The OS notification, which W2.1 owns. Absent = the shell shows none. */
  readonly notify?: (title: string, body: string) => void;
  /**
   * electron-updater 本体，第一次真的要用它时才取。
   *
   * 默认实现是一次延迟的 `require`，这是本批的内存改动：量出来这个包要
   * 16.5 MB RSS、159 个模块（`builder-util-runtime`、`js-yaml`、`fs-extra`、
   * `semver` 整棵树），而绝大多数会话里没有人按过「检查更新」，它从头到尾一次
   * 也没被调用。挪到下面这个函数之后，这笔常驻只有下载 / 安装那条路径才付。
   *
   * 为什么是 `require` 不是 `import()`：主进程的产物是 CJS 且装在 asar 里，
   * 实测 `import()` 走得通，但 `autoUpdater` 是个 getter，CJS 具名导出探测
   * 认不出来，拿回来是 `undefined`——更新会悄悄不工作。
   */
  readonly updaterModule?: () => typeof import("electron-updater");
  /**
   * The four answers about this installation (`environment.ts`). Injected by
   * tests that need a packaged, unsigned build without being one; read fresh
   * on every use otherwise, because it is cheap and a cached Windows
   * signature read is already memoised underneath.
   */
  readonly environment?: () => UpdaterEnvironment;
  /** The unsigned installers' process work (`install.ts`). Tests inject. */
  readonly installers?: Installers;
  /** The running `.app` (macOS). Defaults to the one `process.execPath` is in. */
  readonly appBundle?: () => string | null;
  /** The language of the notification. Defaults to the environment's. */
  readonly locale?: () => Locale;
}

declare const require: (id: string) => unknown;

let loaded: typeof import("electron-updater") | null = null;

function loadElectronUpdater(): typeof import("electron-updater") {
  loaded ??= require("electron-updater") as typeof import("electron-updater");
  return loaded;
}

export class UpdatesController {
  private machine: Machine | null = null;
  private readonly cancellation = new Cancellation();
  /** Set while a transfer is being awaited, so a cancel can stop the bytes. */
  private transfer: Pick<CancellationToken, "cancel"> | null = null;
  private staged: { offer: Offer; file: string } | null = null;
  private readonly stagedListeners = new Set<(staged: Staged) => void>();
  /** The channel of the last check; a download uses the same one. */
  private channel: offer.Channel = "stable";

  constructor(private readonly deps: UpdatesDeps) {}

  private installers(): Installers {
    return this.deps.installers ?? defaultInstallers(() => app.quit());
  }

  /** electron-updater 本体。没人注入就走那次延迟的 `require`。 */
  private updater(): typeof import("electron-updater") {
    return (this.deps.updaterModule ?? loadElectronUpdater)();
  }

  /**
   * The staged-update announcement, for the tray item W2.1 adds. The tray
   * shows "restart to finish updating" while `ready` and hides it otherwise;
   * pressing it runs the same confirmed restart the settings page runs, which
   * is `install()` below.
   */
  onStaged(listener: (staged: Staged) => void): () => void {
    this.stagedListeners.add(listener);
    return () => this.stagedListeners.delete(listener);
  }

  /* ------------------------------ the state ------------------------------ */

  private environment(): UpdaterEnvironment {
    return (this.deps.environment ?? updaterEnvironment)();
  }

  private current(): Machine {
    this.machine ??= Machine.of(initialState(this.environment()));
    return this.machine;
  }

  /** The state as it stands. Reads nothing off the network. */
  state(): UpdateState {
    return this.current().state();
  }

  private apply(event: Event): UpdateState {
    this.current().apply(event);
    return this.state();
  }

  /* ------------------------------- the check ----------------------------- */

  /**
   * Records the Host's answer and, when it is an offer, cross-checks it
   * against the release manifest before calling anything available (§2.2).
   */
  async check(input: unknown): Promise<UpdateState> {
    const started = this.apply({ type: "checkStarted" });
    if (started.state !== "checking") return started;
    return this.apply(
      await evaluate(readVerdict(input), null, this.environment().pubkey ?? ""),
    );
  }

  /**
   * Asks the release index itself (external services §3.1, §3.4): the index at
   * `releaseSource()`, conditionally on the last answer's `ETag` so an
   * unchanged index costs a 304 rather than a rate-limited call; only releases
   * the `updates.channel` setting allows; then the same cross-check against
   * the manifest every Host answer goes through, and the staged rollout.
   *
   * `manual` is a person pressing "check"; otherwise the call is the timer's,
   * and it does nothing until the interval since the last check has passed.
   */
  async checkRelease(
    options: { manual?: boolean; nowMs?: number } = {},
  ): Promise<UpdateState> {
    const now = this.state();
    const managed =
      now.state === "unsupported" && now.managed !== undefined
        ? now.managed
        : null;
    if (managed === null && !shouldEnableUpdater(this.environment())) {
      return this.state();
    }
    const source = releaseSource();
    const target = currentTarget();
    if (source === null || target === null) return this.state();
    const nowMs = options.nowMs ?? Date.now();
    const directory = dataDir();
    const settings = await this.readSettings();
    this.channel = offer.channelFrom(settings);
    const key = coordinate.releaseCacheKey(source, this.channel);
    const cached = coordinate.readReleaseCache(directory);
    const usable = cached !== null && cached.key === key ? cached : null;
    if (
      options.manual !== true &&
      usable !== null &&
      nowMs - usable.checkedAtMs < coordinate.MIN_CHECK_INTERVAL_MS
    ) {
      return this.state();
    }
    if (managed !== null) {
      // A package the shell must not replace still learns which installer is
      // newer, so the page can offer it for download. Nothing is staged.
      const index = await fetchIndex(source, usable);
      if (!index.ok) return this.state();
      coordinate.writeReleaseCache(directory, {
        key,
        etag: index.etag,
        body: index.body,
        checkedAtMs: nowMs,
      });
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(index.body);
      } catch {
        parsed = null;
      }
      this.machine = Machine.of({
        state: "unsupported",
        reason: "managedPackage",
        managed: {
          package: managed.package,
          download: managedDownload(
            parsed,
            {
              channel: this.channel,
              currentVersion: app.getVersion(),
              target,
              checkedAtMs: nowMs,
            },
            managed.package,
          ),
        },
      });
      return this.state();
    }
    const started = this.apply({ type: "checkStarted" });
    if (started.state !== "checking") return started;
    const index = await fetchIndex(source, usable);
    if (!index.ok) {
      return this.apply({
        type: "checkRefused",
        reason: index.reason,
        retryAfterMs: index.retryAfterMs,
        atMs: nowMs,
      });
    }
    coordinate.writeReleaseCache(directory, {
      key,
      etag: index.etag,
      body: index.body,
      checkedAtMs: nowMs,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(index.body);
    } catch {
      parsed = null;
    }
    const verdict = offer.releaseVerdict(parsed, {
      channel: this.channel,
      currentVersion: app.getVersion(),
      target,
      checkedAtMs: nowMs,
    });
    if (this.state().state !== "checking") return this.state();
    return this.apply(
      await evaluate(
        verdict,
        coordinate.installId(directory),
        this.environment().pubkey ?? "",
      ),
    );
  }

  /**
   * The automatic check: once after start-up, then every six hours or more,
   * spread by jitter (`coordinate.nextCheckDelayMs`), and only while
   * `updates.autoCheck` is on. Returns the stop function.
   */
  startSchedule(random: () => number = Math.random): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const arm = () => {
      if (stopped) return;
      const cached = coordinate.readReleaseCache(dataDir());
      timer = setTimeout(
        () => void run(),
        coordinate.nextCheckDelayMs(
          cached?.checkedAtMs ?? null,
          Date.now(),
          random(),
        ),
      );
      timer.unref?.();
    };
    const run = async () => {
      try {
        if (offer.autoCheckFrom(await this.readSettings())) {
          await this.checkRelease();
        }
      } catch {
        // A failed automatic check is reported through the state, or not at
        // all; it never stops the next one.
      }
      arm();
    };
    arm();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }

  private async readSettings(): Promise<Uint8Array | string> {
    try {
      return await this.deps.settings();
    } catch {
      return "";
    }
  }

  /** "Skip this version": claims nothing about whether a newer one exists. */
  dismiss(): UpdateState {
    return this.apply({ type: "offerDismissed" });
  }

  /**
   * Stops what is in flight: a transfer, or a check.
   *
   * A cancelled transfer discards its bytes and goes back to the offer (§2.1).
   * There is no resume, so half a package is not something to keep, and the
   * shell says "available" again rather than pretending the partial file is
   * worth anything.
   */
  cancel(): UpdateState {
    const state = this.state();
    if (state.state === "downloading") {
      this.cancellation.cancel();
      // electron-updater's own token is what actually closes the response
      // body; the shell's token is what stops it being awaited.
      this.transfer?.cancel();
      return this.apply({ type: "checkCancelled" });
    }
    if (state.state === "checking") {
      // A check in flight is one await that cannot be interrupted; leaving
      // `checking` is enough, because its answer is only accepted from
      // `checking` and will be ignored when it lands.
      return this.apply({ type: "checkCancelled" });
    }
    return state;
  }

  /* ----------------------------- the transfer ---------------------------- */

  /**
   * Downloads the offered bundle, lets electron-updater verify its signature,
   * checks the digest the Host published, and stages it. Nothing is installed.
   */
  async download(): Promise<UpdateState> {
    // A failure that kept its offer is retried from the offer, so a person
    // pressing "try again" does not have to check first.
    if (this.state().state === "failed") this.apply({ type: "retry" });
    const started = this.apply({ type: "downloadStarted" });
    if (started.state !== "downloading") return started;
    const pending = started.offer;

    const token = this.cancellation.arm();
    const outcome = await Promise.race([
      this.transferBytes(pending).then((result) => ({ result })),
      token.notified().then(() => null),
    ]);
    this.cancellation.finish(token);
    this.transfer = null;
    if (outcome === null) {
      // `cancel()` already moved the machine back to the offer; report where
      // things actually stand rather than a second, racing transition.
      return this.state();
    }
    const result = outcome.result;
    if (!result.ok) {
      return this.apply({ type: "downloadFailed", reason: result.reason });
    }
    const state = this.apply({ type: "downloadFinished" });
    // A transfer that finished *while* it was being cancelled is not a staged
    // update: the machine refused the event, and keeping the bytes would let a
    // later restart install something nobody chose.
    if (state.state !== "downloaded") return state;
    this.staged = { offer: pending, file: result.value };
    await this.announceStaged(pending);
    return state;
  }

  /**
   * The bytes for the installer this installation will use, then the release
   * key's statement about them. A bundle that fails either is never staged.
   */
  private async transferBytes(pending: Offer): Promise<offer.Resolved<string>> {
    const environment = this.environment();
    // A package nothing may install (the development escape hatch on an
    // unsigned build) still walks electron-updater's transfer, as it always did.
    const path: InstallPath = installPath(environment) ?? "electronUpdater";
    const fetched =
      path === "electronUpdater"
        ? await this.updaterTransfer(pending)
        : await this.directTransfer(pending);
    if (!fetched.ok) return fetched;
    if (requiresDetachedSignature(environment)) {
      const signed = await verifySignature(
        pending,
        fetched.value,
        environment.pubkey ?? "",
      );
      if (!signed.ok) {
        // Bytes the release key does not vouch for are not kept around.
        if (path !== "electronUpdater") {
          rmSync(downloadDir(), { recursive: true, force: true });
        }
        return signed;
      }
    }
    return fetched;
  }

  /** One progress reading, to the machine and to the page. */
  private progressed(pending: Offer, transferred: number, total: number): void {
    this.apply({
      type: "downloadProgressed",
      receivedBytes: transferred,
      totalBytes: total,
    });
    // Resolved at send time. See the rule at the top of this file.
    sendToWindow(IPC.updatesProgress.channel, {
      receivedBytes: transferred,
      totalBytes: total || pending.sizeBytes,
    });
  }

  /**
   * The bundle fetched by the shell itself, for the installers that are not
   * electron-updater's: into `<data>/updates/download/`, hashed while it
   * streams, and never longer than the size GitHub published for it.
   */
  private async directTransfer(
    pending: Offer,
  ): Promise<offer.Resolved<string>> {
    let feed: URL;
    try {
      feed = new URL(pending.manifestUrl);
    } catch {
      return { ok: false, reason: "sourceMalformed" };
    }
    // The same feed check as electron-updater's path: the release's own
    // description of this target has to name exactly this bundle.
    const checkedFeed = await verifiedFeed(pending, feed);
    if (!checkedFeed.ok) return checkedFeed;
    const directory = downloadDir();
    const file = join(directory, stagedFileName(pending.packageUrl));
    const abort = new AbortController();
    this.transfer = { cancel: () => abort.abort() };
    let oversized = false;
    try {
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
      const response = await fetch(pending.packageUrl, {
        signal: abort.signal,
        redirect: "follow",
      });
      if (!response.ok || response.body === null) {
        return {
          ok: false,
          reason:
            response.status === 404
              ? "noArtifactForTarget"
              : "downloadInterrupted",
        };
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      const limit = pending.sizeBytes > 0 ? pending.sizeBytes : Infinity;
      if (declared > limit) return { ok: false, reason: "digestMismatch" };
      const total = declared > 0 ? declared : pending.sizeBytes;
      const hash = createHash("sha256");
      let received = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          if (received > limit) {
            oversized = true;
            callback(new Error("more bytes than the release published"));
            return;
          }
          hash.update(chunk);
          this.progressed(pending, received, total);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
        meter,
        createWriteStream(file),
      );
      const verified = offer.verifyDigestHex(
        hash.digest("hex"),
        pending.sha256,
      );
      if (!verified.ok) {
        rmSync(directory, { recursive: true, force: true });
        return verified;
      }
      return { ok: true, value: file };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      // More bytes than were published are not these bytes, whatever they are.
      if (oversized) return { ok: false, reason: "digestMismatch" };
      return { ok: false, reason: transferReason(error) };
    }
  }

  /** electron-updater's own transfer, for the installers that are its. */
  private async updaterTransfer(
    pending: Offer,
  ): Promise<offer.Resolved<string>> {
    let feed: URL;
    try {
      feed = new URL(pending.manifestUrl);
    } catch {
      return { ok: false, reason: "sourceMalformed" };
    }
    // The feed electron-updater is about to read is checked by the shell first:
    // the one the release's `latest.json` names, by digest, describing exactly
    // the bundle on offer. A release without one would 404 a step later.
    const checkedFeed = await verifiedFeed(pending, feed);
    if (!checkedFeed.ok) return checkedFeed;
    const { CancellationToken, autoUpdater } = this.updater();
    // The feed of the release the Host offered, not an address this bundle was
    // built with: that is what lets a beta build update.
    autoUpdater.setFeedURL({
      provider: "generic",
      url: new URL(offer.directory(feed), feed).toString(),
    });
    // One release directory holds six targets' feeds; the channel picks this
    // target's (`latest-<target>….yml`, `offer.feedName`). Setting a channel
    // turns `allowDowngrade` on as a side effect — turned off again at once,
    // because the Host's offer is what decides the version, never a downgrade.
    autoUpdater.channel = offer.updaterChannel(pending.target);
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = offer.allowPrerelease(this.channel);
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // The digest below is checked against the file that arrives, and a
    // differential download reassembles a file from blocks this shell never
    // saw published. Ask for the whole artifact so the two statements — the
    // Host's sha256 and these bytes — are about the same thing.
    autoUpdater.disableDifferentialDownload = true;
    // A development build has no `app-update.yml`, so electron-updater would
    // refuse to do anything at all. Measured while walking a local release
    // server: `setFeedURL` is enough for the *check*, but the download path
    // re-reads the update config from disk, so a development walkthrough also
    // needs a `dev-app-update.yml` beside the app — otherwise the transfer
    // fails with ENOENT on that file and nothing says why.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;

    const onProgress = (progress: { transferred: number; total: number }) =>
      this.progressed(pending, progress.transferred, progress.total);
    autoUpdater.on("download-progress", onProgress);
    const token = new CancellationToken();
    this.transfer = token;
    try {
      const found = await autoUpdater.checkForUpdates();
      if (!found?.updateInfo) {
        // The Host said there is one and the manifest agreed; the updater
        // disagreeing means the two documents describe different things.
        return { ok: false, reason: "sourceMalformed" };
      }
      if (found.updateInfo.version.replace(/^v+/, "") !== pending.version) {
        return { ok: false, reason: "sourceMalformed" };
      }
      const files = await autoUpdater.downloadUpdate(token);
      const file = files?.[0];
      if (typeof file !== "string" || file.length === 0) {
        return { ok: false, reason: "downloadInterrupted" };
      }
      // electron-updater verified what it verifies. This is the second,
      // independent statement: the digest the *Host* published for these
      // bytes (design §2.2, inventory §2 item 20).
      const digest = await digestOfFile(file);
      if (digest === null) return { ok: false, reason: "downloadInterrupted" };
      const verified = offer.verifyDigestHex(digest, pending.sha256);
      if (!verified.ok) return verified;
      return { ok: true, value: file };
    } catch (error) {
      return { ok: false, reason: transferReason(error) };
    } finally {
      autoUpdater.off("download-progress", onProgress);
    }
  }

  /* ------------------------------ the restart ---------------------------- */

  /**
   * Stops what this shell owns, records the restart, and installs. On success
   * this call does not return: the process is replaced, or it quits and a
   * helper / the installer takes over.
   */
  async install(): Promise<UpdateState> {
    const preparing = this.apply({ type: "restartRequested" });
    if (preparing.state !== "downloaded" || preparing.phase !== "preparing") {
      return preparing;
    }
    const pending = preparing.offer;
    const environment = this.environment();

    // A package that carries neither the release key nor a platform signature
    // stages and verifies updates (with ARMADRA_UPDATES_DEV=1) but never hands
    // them to an installer. Checked before anything is stopped: nothing about
    // this restart is going to happen, so nothing should be interrupted for it.
    const refusal = installRefusal(environment);
    if (refusal !== null) {
      return this.apply({ type: "restartAbandoned", reason: refusal });
    }
    const path = installPath(environment) ?? "electronUpdater";
    if (this.staged === null && path !== "electronUpdater") {
      return this.apply({ type: "restartAbandoned", reason: "installFailed" });
    }

    // Everything that can fail without stopping anything is done first: the
    // macOS bundle is unpacked and its version read while the app still runs.
    let macReplace: { installed: string; replacement: string } | null = null;
    if (path === "macReplace" && this.staged !== null) {
      const installed = (this.deps.appBundle ?? defaultAppBundle)();
      if (installed === null || !this.installers().replaceable(installed)) {
        return this.apply({
          type: "restartAbandoned",
          reason: "installFailed",
        });
      }
      const unpacked = await this.installers().stageMacBundle(
        this.staged.file,
        pending.version,
        installDir(),
      );
      if (!unpacked.ok) {
        return this.apply({
          type: "restartAbandoned",
          reason: unpacked.reason,
        });
      }
      macReplace = { installed, replacement: unpacked.value };
    }

    const stopped = await this.stopOwnedBackground();
    if (stopped !== null) {
      // The install never started. Nothing was replaced, nothing was written,
      // and the update goes back to waiting with the reason attached.
      return this.apply({ type: "restartAbandoned", reason: stopped });
    }

    const written = coordinate.writePending(dataDir(), {
      expectedVersion: pending.version,
      previousVersion: app.getVersion(),
      previousPackageUrl: "",
      notesUrl: pending.notesUrl,
      startedAtMs: Date.now(),
    });
    if (!written.ok) {
      return this.apply({ type: "restartAbandoned", reason: written.reason });
    }

    this.apply({ type: "backgroundStopped" });
    if (this.staged === null) {
      return this.failInstall("installFailed");
    }
    if (path === "macReplace" && macReplace !== null) {
      return this.handOver(
        this.installers().launchMacHelper({
          pid: process.pid,
          installed: macReplace.installed,
          replacement: macReplace.replacement,
          workDir: installDir(),
        }),
      );
    }
    if (path === "windowsInstaller") {
      return this.handOver(
        this.installers().launchWindowsInstaller(this.staged.file),
      );
    }
    try {
      // 走到这一步必然已经下载过，模块早就加载好了；这里只是把句柄再取一次。
      const { autoUpdater } = this.updater();
      // On macOS `quitAndInstall` only *asks* Squirrel.Mac, which then fetches
      // the staged zip and checks it against this app's designated requirement
      // — a different signer (a rotated certificate, an ad-hoc rehearsal build)
      // is refused there, asynchronously, as an `error` event. Without this the
      // page would sit in "installing" while nothing happens.
      autoUpdater.once("error", (error: unknown) => {
        const now = this.state();
        if (now.state === "downloaded" && now.phase === "installing") {
          this.failInstall(transferReason(error));
        }
      });
      this.deps.onBeforeRestart();
      // Never returns: the installer replaces this process.
      autoUpdater.quitAndInstall();
      return this.state();
    } catch (error) {
      return this.failInstall(transferReason(error));
    }
  }

  /**
   * The helper or the installer is started; this process quits so it can do
   * its work. A start that failed installs nothing and says so.
   */
  private handOver(launched: offer.Resolved<void>): UpdateState {
    if (!launched.ok) return this.failInstall(launched.reason);
    this.deps.onBeforeRestart();
    this.installers().quit();
    return this.state();
  }

  /**
   * The install did not happen, so nothing should tell the next start that it
   * did — and the tray must stop offering a restart that would only fail the
   * same way.
   */
  private failInstall(reason: Reason): UpdateState {
    coordinate.clearPending(dataDir());
    this.staged = null;
    this.announce(stagedCleared());
    return this.apply({ type: "installFailed", reason });
  }

  /**
   * Stops the background this shell started (design §2.3): that is only the
   * in-process Runtime now. Returns the reason it could not, or `null` when it
   * is down.
   *
   * 原因码仍叫 `hostStopFailed`：它是页面与文案共用的线上取值，含义是「后台停
   * 不下来，所以不装」，不因独立 Host 进程拆掉而改名。
   */
  private async stopOwnedBackground(): Promise<Reason | null> {
    try {
      await this.deps.runtime.stop();
    } catch {
      return "hostStopFailed";
    }
    return null;
  }

  /**
   * Whether the last restart delivered what it promised (design §2.3, R6).
   *
   * The page calls this once at startup. `null` means no update was pending,
   * which is the ordinary case and is not reported to anybody.
   */
  async restartReport(): Promise<coordinate.RestartOutcome | null> {
    const directory = dataDir();
    const pending = coordinate.readPending(directory);
    if (pending === null) return null;
    const outcome = coordinate.verifyRestart(pending, {
      shell: app.getVersion(),
      runtime: await this.deps.runtimeVersion(),
    });
    if (outcome.outcome === "completed") {
      coordinate.clearPending(directory);
      // The bytes that were installed are not needed any more.
      rmSync(downloadDir(), { recursive: true, force: true });
      rmSync(installDir(), { recursive: true, force: true });
    }
    return outcome;
  }

  /* ---------------------------- announcements ---------------------------- */

  /**
   * Tells the tray and the person that a restart is all that is left
   * (design §4.1, last rule).
   *
   * Both announcements are best-effort: an update that is staged stays staged
   * whether or not the notification could be shown, and the settings page says
   * the same thing without either of them.
   */
  private async announceStaged(pending: Offer): Promise<void> {
    const installable = installRefusal(this.environment()) === null;
    this.announce(stagedReady(pending.version, installable));
    if (this.deps.notify === undefined) return;
    let settings: Uint8Array | string;
    try {
      settings = await this.deps.settings();
    } catch {
      settings = "";
    }
    if (!wantsNotification(settings)) return;
    const locale = (this.deps.locale ?? localeFromEnvironment)();
    this.deps.notify(
      notificationTitle(locale),
      installable
        ? notificationBody(locale, pending.version)
        : unsignedNotificationBody(locale, pending.version),
    );
  }

  /**
   * The announcement goes to the shell's own listeners — the tray W2.1 adds —
   * and no further. It reaches no renderer channel, because the IPC table of
   * design §2.2 declares no `updates:staged`: the page does not need one while
   * `autoDownload` is off, since no transfer finishes that the page did not
   * ask for. `STAGED_EVENT` is kept as the name both sides would use if that
   * ever changes.
   */
  private announce(staged: Staged): void {
    for (const listener of this.stagedListeners) listener(staged);
  }
}

/* --------------------------------- helpers -------------------------------- */

async function evaluate(
  verdict: HostVerdict,
  installId: string | null = null,
  pubkey = "",
): Promise<Event> {
  const atMs = verdict.checkedAtMs;
  if (verdict.state === "upToDate") {
    return { type: "checkedUpToDate", atMs };
  }
  if (verdict.state === "available") {
    const resolved = await resolveOffer(verdict, pubkey);
    // A staged rollout that does not include this installation is no offer
    // for it — the same answer electron-updater's own staging gives. The check
    // was made; the release is simply not this installation's yet.
    if (
      resolved.ok &&
      installId !== null &&
      !offer.rolloutAccepts(resolved.rollout, installId)
    ) {
      return { type: "checkedUpToDate", atMs };
    }
    return resolved.ok
      ? { type: "checkedAvailable", offer: resolved.value }
      : {
          type: "checkRefused",
          reason: resolved.reason,
          retryAfterMs: verdict.retryAfterMs,
          atMs,
        };
  }
  // "unsupported", "unavailable" and anything this build has never heard of
  // are all "the check did not produce an answer".
  return {
    type: "checkRefused",
    reason: reasonFor(verdict.reasonCode),
    retryAfterMs: verdict.retryAfterMs,
    atMs,
  };
}

async function resolveOffer(
  verdict: HostVerdict,
  pubkey: string,
): Promise<
  | { ok: true; value: Offer; rollout: offer.Rollout | null }
  | { ok: false; reason: Reason }
> {
  const insecure = allowInsecureLoopback();
  const target = offer.pointer(verdict.answer, verdict.target, insecure);
  if (!target.ok) return target;
  const manifest = await fetchManifest(target.value.url);
  if (!manifest.ok) return manifest;
  // With the release key, a `latest.json` entry signed by another key is
  // refused here, before any bytes are fetched. See `offer.ts`.
  const resolved = offer.resolve(
    verdict.answer,
    target.value,
    manifest.value,
    pubkey,
    insecure,
  );
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    value: resolved.value,
    rollout: offer.readRollout(manifest.value),
  };
}

/**
 * The feed for the offer, fetched and checked before electron-updater is
 * pointed at it. When the offer came from `latest.json`, the feed is the one
 * it names, by digest; when it came from a feed directly, that feed is read
 * again and has to describe the same bundle.
 */
async function verifiedFeed(
  pending: Offer,
  manifest: URL,
): Promise<offer.Resolved<void>> {
  const insecure = allowInsecureLoopback();
  let feedUrl = manifest;
  let expected: string | null = null;
  if (manifest.pathname.endsWith("/latest.json")) {
    const text = await fetchManifest(manifest);
    if (!text.ok) return text;
    const named = offer.feedFor(text.value, pending.target);
    if (!named.ok) return named;
    const url = offer.releaseUrl(named.value.url, insecure);
    if (!url.ok) return url;
    if (!offer.sameRelease(url.value, manifest)) {
      return { ok: false, reason: "sourceMalformed" };
    }
    feedUrl = url.value;
    expected = named.value.sha256;
  }
  if (!feedUrl.pathname.endsWith(`/${offer.feedName(pending.target)}`)) {
    return { ok: false, reason: "sourceMalformed" };
  }
  const feedText = await fetchManifest(feedUrl);
  if (!feedText.ok) return feedText;
  return offer.verifyFeed(feedText.value, expected, feedUrl, pending);
}

/** The release index as fetched: a fresh body, or the cached one on a 304. */
type IndexAnswer =
  | { ok: true; etag: string; body: string }
  | { ok: false; reason: Reason; retryAfterMs: number };

/** The largest release index read; GitHub's first page is far below it. */
const INDEX_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * `GET <source>/releases`, conditional on the cached `ETag`. A 304 reuses the
 * cached body; a 403 / 429 is the rate limit, and its reset time becomes the
 * retry hint rather than a "could not check" that invites pressing again.
 */
async function fetchIndex(
  source: string,
  cached: coordinate.ReleaseCache | null,
): Promise<IndexAnswer> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
  };
  if (cached !== null && cached.etag.length > 0) {
    headers["if-none-match"] = cached.etag;
  }
  let response: Response;
  try {
    response = await fetch(`${source}/releases?per_page=30`, {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
  } catch {
    return { ok: false, reason: "sourceUnreachable", retryAfterMs: 0 };
  }
  if (response.status === 304 && cached !== null) {
    return { ok: true, etag: cached.etag, body: cached.body };
  }
  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0");
    const after = Number(response.headers.get("retry-after") ?? "0");
    const retryAfterMs =
      after > 0
        ? after * 1000
        : reset > 0
          ? Math.max(0, reset * 1000 - Date.now())
          : 0;
    return { ok: false, reason: "sourceUnreachable", retryAfterMs };
  }
  if (!response.ok) {
    return { ok: false, reason: "sourceUnreachable", retryAfterMs: 0 };
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > INDEX_LIMIT_BYTES) {
    return { ok: false, reason: "sourceMalformed", retryAfterMs: 0 };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "sourceUnreachable", retryAfterMs: 0 };
  }
  if (body.length > INDEX_LIMIT_BYTES) {
    return { ok: false, reason: "sourceMalformed", retryAfterMs: 0 };
  }
  return { ok: true, etag: response.headers.get("etag") ?? "", body };
}

/**
 * Reads the release manifest, bounded. A body that claims to be larger than a
 * manifest ever is refused before it is read, not after.
 */
async function fetchManifest(url: URL): Promise<offer.Resolved<string>> {
  const abort = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: abort, redirect: "follow" });
  } catch {
    return { ok: false, reason: "sourceUnreachable" };
  }
  if (!response.ok) return { ok: false, reason: "sourceUnreachable" };
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > offer.MANIFEST_LIMIT_BYTES) {
    return { ok: false, reason: "sourceMalformed" };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "sourceUnreachable" };
  }
  if (body.length > offer.MANIFEST_LIMIT_BYTES) {
    return { ok: false, reason: "sourceMalformed" };
  }
  return { ok: true, value: body };
}

/** Where the shell's own transfer puts a bundle. */
function downloadDir(): string {
  return join(dataDir(), "updates", "download");
}

/** Where the macOS bundle is unpacked and the helper works. */
function installDir(): string {
  return join(dataDir(), "updates", "install");
}

function defaultAppBundle(): string | null {
  return appBundleOf(process.execPath);
}

/**
 * The release key's statement about a downloaded bundle: `<asset>.sig` from the
 * same release, verified over the bytes with the key this package carries, and
 * naming this asset in its trusted comment. A missing, malformed or foreign
 * signature is `signatureMismatch`; only a transfer that failed is something
 * else.
 */
async function verifySignature(
  pending: Offer,
  file: string,
  pubkey: string,
): Promise<offer.Resolved<void>> {
  const url = offer.releaseUrl(
    `${pending.packageUrl}.sig`,
    allowInsecureLoopback(),
  );
  if (!url.ok) return url;
  let text: string;
  try {
    const response = await fetch(url.value, {
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!response.ok) {
      return {
        ok: false,
        reason:
          response.status === 404 || response.status === 410
            ? "signatureMismatch"
            : "sourceUnreachable",
      };
    }
    text = await response.text();
  } catch {
    return { ok: false, reason: "sourceUnreachable" };
  }
  if (text.length > SIGNATURE_LIMIT_BYTES) {
    return { ok: false, reason: "signatureMismatch" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return { ok: false, reason: "downloadInterrupted" };
  }
  const verdict = verifyDetached(
    pubkey,
    text,
    bytes,
    assetNameOf(pending.packageUrl),
  );
  return verdict.ok
    ? { ok: true, value: undefined }
    : { ok: false, reason: "signatureMismatch" };
}

/** The sha256 of a staged file, streamed. `null` when it could not be read. */
function digestOfFile(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * A transfer or install error as one of the stable reason tokens. The error's
 * own text is never surfaced: it carries the endpoint, and an endpoint can
 * carry a token.
 */
export function transferReason(error: unknown): Reason {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOSPC") return "diskFull";
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase();
  if (message.includes("cancelled") || message.includes("canceled")) {
    return "downloadInterrupted";
  }
  if (message.includes("sha512") || message.includes("checksum")) {
    return "digestMismatch";
  }
  if (message.includes("signature") || message.includes("code sign")) {
    return "signatureMismatch";
  }
  if (message.includes("no such file") || message.includes("enoent")) {
    return "installFailed";
  }
  if (
    message.includes("net::") ||
    message.includes("econn") ||
    message.includes("etimedout") ||
    message.includes("socket")
  ) {
    return "downloadInterrupted";
  }
  if (message.includes("404") || message.includes("not found")) {
    return "noArtifactForTarget";
  }
  if (
    message.includes("updater is not") ||
    message.includes("app-update.yml")
  ) {
    return "updaterUnavailable";
  }
  return "sourceMalformed";
}
