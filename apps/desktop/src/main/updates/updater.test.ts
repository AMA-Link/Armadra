/**
 * The electron-updater wiring, against stand-ins for Electron and for the
 * updater itself.
 *
 * The state machine's own contract is tested without any of this
 * (`shell-core/updates/machine.test.ts`, 195 table entries). What is worth
 * testing here is the part that only exists once the two are joined, and the
 * one rule that is Armadra's alone:
 *
 * **A Runtime that will not stop means nothing is installed.** Not "installed
 * anyway", not "installed after a timeout" — the installer is never reached,
 * no pending record is written, and the update goes back to waiting with
 * `hostStopFailed` attached so the page can say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdaterEnvironment } from "../../shell-core/updates/availability";
import type { Installers } from "./install";

const RELEASE = "http://127.0.0.1:8123/v0.2.0";
const BUNDLE = `${RELEASE}/Armadra-0.2.0-arm64-mac.zip`;
const PAYLOAD = "armadra-0.2.0";
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

/* ------------------------------- stand-ins -------------------------------- */

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableDifferentialDownload = false;
  forceDevUpdateConfig = false;
  feed: unknown = null;
  installs = 0;
  /** Set to make `downloadUpdate` reject instead of resolving. */
  failure: Error | null = null;
  /** The file `downloadUpdate` resolves with. */
  file = "";
  version = "0.2.0";
  /** Resolves only once `release()` is called, for the cancellation test. */
  hold: (() => void) | null = null;

  setFeedURL(feed: unknown) {
    this.feed = feed;
  }

  checkForUpdates() {
    return Promise.resolve({ updateInfo: { version: this.version } });
  }

  async downloadUpdate(token: { cancel: () => void }) {
    this.emit("download-progress", { transferred: 7, total: 13 });
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.hold = resolve;
        // The shell's cancel reaches electron-updater through this token.
        void token;
      });
    }
    if (this.failure) throw this.failure;
    return [this.file];
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

const updater = new FakeUpdater();
const cancellations: { cancelled: boolean }[] = [];

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.1.0",
    getAppPath: () => "/nowhere",
    getLocale: () => "en",
  },
}));

/**
 * electron-updater 的替身，经 `UpdatesDeps.updaterModule` 注入。
 *
 * 不是 `vi.mock("electron-updater")`：生产代码是延迟 `require` 它的（省下
 * 16.5 MB 常驻，理由写在 `updater.ts` 的 `updaterModule` 那一条），而
 * `vi.mock` 拦的是 import。注入是同一件事说得更直白的那种写法。
 */
const updaterModule = () =>
  ({
    get autoUpdater() {
      return updater;
    },
    CancellationToken: class {
      cancelled = false;
      constructor() {
        cancellations.push(this);
      }
      cancel() {
        this.cancelled = true;
        updater.hold?.();
      }
    },
  }) as unknown as typeof import("electron-updater");

const sent: { channel: string; payload: unknown }[] = [];
vi.mock("../window", () => ({
  sendToWindow: (channel: string, payload: unknown) => {
    sent.push({ channel, payload });
  },
  markQuitting: () => undefined,
  getMainWindow: () => null,
}));

/* --------------------------------- fixture -------------------------------- */

const FEED = [
  "version: 0.2.0",
  "files:",
  "  - url: Armadra-0.2.0-arm64-mac.zip",
  "    size: 13",
  "",
].join("\n");

function verdict() {
  return {
    state: "available",
    reasonCode: "",
    retryAfterMs: 0,
    checkedAtMs: 1_700_000_000_000,
    target: "darwin-aarch64",
    answer: {
      version: "0.2.0",
      notesUrl: "https://releases.invalid/v0.2.0",
      artifacts: [
        {
          component: "manifest",
          target: "",
          url: `${RELEASE}/latest-darwin-aarch64-mac.yml`,
          sizeBytes: 200,
          sha256: "b".repeat(64),
          signed: false,
        },
        {
          component: "desktop",
          target: "darwin-aarch64",
          url: BUNDLE,
          sizeBytes: 13,
          sha256: DIGEST,
          signed: false,
        },
      ],
    },
  };
}

let directory: string;
let stagedFile: string;
let runtimeStops: () => Promise<void>;
let restarts: number;

interface Subject {
  controller: import("./updater").UpdatesController;
}

async function subject(
  overrides: Partial<import("./updater").UpdatesDeps> = {},
): Promise<Subject> {
  const { UpdatesController } = await import("./updater");
  return {
    controller: new UpdatesController({
      runtime: { stop: () => runtimeStops() },
      runtimeVersion: async () => "0.2.0",
      onBeforeRestart: () => {
        restarts += 1;
      },
      settings: async () => "",
      updaterModule,
      ...overrides,
    }),
  };
}

/** Walks a fresh controller as far as "downloaded, waiting for a restart". */
async function staged(overrides = {}) {
  const { controller } = await subject(overrides);
  expect((await controller.check(verdict())).state).toBe("available");
  expect((await controller.download()).state).toBe("downloaded");
  return controller;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-updater-"));
  stagedFile = join(directory, "Armadra-0.2.0-arm64-mac.zip");
  writeFileSync(stagedFile, PAYLOAD);
  process.env.ARMADRA_DATA_DIR = directory;
  // A development build only reaches a loopback release server when it was
  // explicitly asked to. Without both of these it reports `notConfigured`.
  process.env.ARMADRA_UPDATES_DEV = "1";
  process.env.ARMADRA_UPDATER_ENDPOINTS = RELEASE;

  updater.failure = null;
  updater.file = stagedFile;
  updater.version = "0.2.0";
  updater.hold = null;
  updater.installs = 0;
  cancellations.length = 0;
  sent.length = 0;
  restarts = 0;
  runtimeStops = async () => undefined;

  vi.stubGlobal("fetch", async (url: URL | string) => {
    if (String(url) === `${RELEASE}/latest-darwin-aarch64-mac.yml`) {
      return new Response(FEED, { status: 200 });
    }
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.ARMADRA_DATA_DIR;
  delete process.env.ARMADRA_UPDATES_DEV;
  delete process.env.ARMADRA_UPDATER_ENDPOINTS;
});

/* ---------------------------------- tests --------------------------------- */

it("a development build with no escape hatch reports not configured", async () => {
  delete process.env.ARMADRA_UPDATES_DEV;
  delete process.env.ARMADRA_UPDATER_ENDPOINTS;
  const { controller } = await subject();
  expect(controller.state()).toEqual({
    state: "notConfigured",
    missing: { pubkey: true, endpoints: true },
  });
  // And it stays there: a check against a build that could verify nothing must
  // not answer "up to date".
  expect((await controller.check(verdict())).state).toBe("notConfigured");
  expect((await controller.download()).state).toBe("notConfigured");
});

it("checks, downloads and verifies one release against the host's digest", async () => {
  const controller = await staged();
  const state = controller.state();
  expect(state.state).toBe("downloaded");
  if (state.state !== "downloaded") return;
  expect(state.offer.packageUrl).toBe(BUNDLE);
  expect(state.offer.sha256).toBe(DIGEST);
  expect(state.phase).toBe("ready");
  // The feed is the release the Host described, not an address baked into
  // this build.
  expect(updater.feed).toEqual({
    provider: "generic",
    url: `${RELEASE}/`,
  });
  // A differential download reassembles a file this shell never saw
  // published; the digest check below is only meaningful over the whole one.
  expect(updater.disableDifferentialDownload).toBe(true);
  expect(updater.autoDownload).toBe(false);
  // Progress reached the page, resolved at send time.
  expect(sent).toContainEqual({
    channel: "updates:progress",
    payload: { receivedBytes: 7, totalBytes: 13 },
  });
});

it("a bundle whose bytes are not the ones the host described is refused", async () => {
  writeFileSync(stagedFile, "something else entirely");
  const { controller } = await subject();
  await controller.check(verdict());
  const state = await controller.download();
  expect(state).toMatchObject({ state: "failed", reason: "digestMismatch" });
  // Nothing is staged, so a restart has nothing to install.
  expect(updater.installs).toBe(0);
});

it("a feed that offers a different version than the host did is refused", async () => {
  updater.version = "0.9.9";
  const { controller } = await subject();
  await controller.check(verdict());
  expect(await controller.download()).toMatchObject({
    state: "failed",
    reason: "sourceMalformed",
  });
});

it("a cancelled transfer keeps the offer and stops the bytes", async () => {
  updater.hold = () => undefined;
  const { controller } = await subject();
  await controller.check(verdict());
  const running = controller.download();
  // Let the transfer reach its hold before cancelling it.
  await new Promise((resolve) => setImmediate(resolve));
  expect(controller.cancel()).toEqual({
    state: "available",
    offer: expect.objectContaining({ packageUrl: BUNDLE }),
  });
  expect(cancellations.at(-1)?.cancelled).toBe(true);
  // The transfer that completes anyway stages nothing: the machine refused
  // `downloadFinished`, and that refusal is read as "do not keep these bytes".
  expect((await running).state).toBe("available");
  expect(updater.installs).toBe(0);
});

describe("stopping the background before an install (§2.3, R5)", () => {
  it("a runtime that will not stop means nothing is installed", async () => {
    const controller = await staged();
    runtimeStops = () => Promise.reject(new Error("Runtime did not confirm"));

    expect(await controller.install()).toEqual({
      state: "downloaded",
      offer: expect.objectContaining({ version: "0.2.0" }),
      phase: "ready",
      problem: "hostStopFailed",
    });
    // The three things "nothing was installed" actually means.
    expect(updater.installs).toBe(0);
    expect(restarts).toBe(0);
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      false,
    );
  });

  it("a confirmed restart records what it expects before handing over", async () => {
    const controller = await staged();

    await controller.install();

    expect(restarts).toBe(1);
    expect(updater.installs).toBe(1);
    const pending = JSON.parse(
      readFileSync(join(directory, "updates", "pending-restart.json"), "utf8"),
    );
    expect(pending).toMatchObject({
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
    });
  });

  it("an installer that failed leaves no record and retracts the announcement", async () => {
    const controller = await staged();
    const announcements: unknown[] = [];
    controller.onStaged((update) => announcements.push(update));
    updater.quitAndInstall = () => {
      throw new Error("could not write to the application bundle");
    };

    const state = await controller.install();

    expect(state.state).toBe("failed");
    // Nothing should tell the next start that an update happened…
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      false,
    );
    // …and the tray must stop offering a restart that would fail the same way.
    expect(announcements).toContainEqual({
      ready: false,
      version: "",
      installable: false,
    });
    updater.quitAndInstall = FakeUpdater.prototype.quitAndInstall;
  });

  it("an installer that refuses the update later is reported, not waited on forever", async () => {
    const controller = await staged();
    const state = await controller.install();
    expect(state).toMatchObject({ state: "downloaded", phase: "installing" });
    // Squirrel.Mac checks the staged bundle against this app's designated
    // requirement after `quitAndInstall` returned, and says no as an event.
    updater.emit(
      "error",
      new Error(
        "Code signature at URL did not pass validation: code failed to satisfy specified code requirement(s)",
      ),
    );
    expect(controller.state()).toMatchObject({
      state: "failed",
      reason: "signatureMismatch",
    });
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      false,
    );
  });
});

/* ----------------- staged on an unsigned package (G3-3) ------------------ */

describe("an unsigned package stages but never installs", () => {
  /** A packaged build whose platform signature says it cannot be trusted. */
  function unsignedPackage(signature: "unsigned" | "unknown") {
    return () => ({
      packaged: true,
      marker: undefined,
      publishConfigured: true,
      signature,
      developmentOverride: true,
      platform: "darwin",
      pubkey: null,
      managed: null,
    });
  }

  for (const signature of ["unsigned", "unknown"] as const) {
    it(`a ${signature} package is checked, verified and staged, then not installed`, async () => {
      const notices: string[] = [];
      const announcements: unknown[] = [];
      const { controller } = await subject({
        environment: unsignedPackage(signature),
        notify: (_title, body) => notices.push(body),
      });
      controller.onStaged((update) => announcements.push(update));
      expect((await controller.check(verdict())).state).toBe("available");
      // The whole transfer path runs: electron-updater's download and the
      // Host's digest, exactly as for a signed package.
      expect((await controller.download()).state).toBe("downloaded");
      expect(announcements).toEqual([
        { ready: true, version: "0.2.0", installable: false },
      ]);
      // The notification says what is true: verified, staged, not installing.
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/unsigned/);
      expect(notices[0]).not.toMatch(/^Restart/);

      expect(await controller.install()).toEqual({
        state: "downloaded",
        offer: expect.objectContaining({ version: "0.2.0" }),
        phase: "ready",
        problem: "notSigned",
      });
      // Nothing was stopped, written or handed to an installer.
      expect(updater.installs).toBe(0);
      expect(restarts).toBe(0);
      expect(
        existsSync(join(directory, "updates", "pending-restart.json")),
      ).toBe(false);
    });
  }

  it("the same package, signed, installs", async () => {
    const { controller } = await subject({
      environment: () => ({
        ...unsignedPackage("unsigned")(),
        signature: "signed",
      }),
    });
    await controller.check(verdict());
    await controller.download();
    await controller.install();
    expect(updater.installs).toBe(1);
  });
});

describe("the restart report (§2.3, R6)", () => {
  it("says nothing when no update was pending", async () => {
    const { controller } = await subject();
    expect(await controller.restartReport()).toBeNull();
  });

  it("reports the update as unfinished when a reading disagrees", async () => {
    const { controller } = await subject({
      runtimeVersion: async () => "0.1.0",
    });
    const { writePending } = await import(
      "../../shell-core/updates/coordinate"
    );
    writePending(directory, {
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
      previousPackageUrl: "",
      notesUrl: "",
      startedAtMs: 1,
    });
    const outcome = await controller.restartReport();
    expect(outcome).toMatchObject({ outcome: "incomplete" });
    // The record is KEPT, so the page can still offer the previous release.
    expect(existsSync(join(directory, "updates", "pending-restart.json"))).toBe(
      true,
    );
  });
});

/* ------------------------ the shell's own release check -------------------- */

describe("checking the release index (external services §3.1, §3.4)", () => {
  const SOURCE = "http://127.0.0.1:8123/repos/o/r";

  async function target(): Promise<string> {
    const { shellTarget, feedName } = await import(
      "../../shell-core/updates/offer"
    );
    const value = shellTarget(process.platform, process.arch);
    if (value === null || feedName(value) === null) {
      throw new Error("this test needs a platform a release builds for");
    }
    return value;
  }

  /** One release, every asset named the way `tools/release` names it. */
  async function release(
    options: { tag?: string; rollout?: unknown; feedDigest?: string } = {},
  ) {
    const { feedName } = await import("../../shell-core/updates/offer");
    const own = await target();
    const tag = options.tag ?? "v0.2.0";
    const version = tag.slice(1);
    const base = `http://127.0.0.1:8123/download/${tag}`;
    const bundle = `Armadra_${version}_${own}.bin`;
    const feed = feedName(own)!;
    const feedText = [
      `version: ${version}`,
      "files:",
      `  - url: ${bundle}`,
      "    sha512: x",
      `    size: ${PAYLOAD.length}`,
      "",
    ].join("\n");
    const feedDigest = createHash("sha256").update(feedText).digest("hex");
    const latest = JSON.stringify({
      version,
      notes: "",
      pub_date: "1970-01-01T00:00:00.000Z",
      ...(options.rollout ? { rollout: options.rollout } : {}),
      platforms: {
        [own]: {
          signature: "",
          url: `${base}/${bundle}`,
          feed: {
            url: `${base}/${feed}`,
            sha256: options.feedDigest ?? feedDigest,
          },
        },
      },
    });
    const asset = (name: string, digest: string) => ({
      name,
      browser_download_url: `${base}/${name}`,
      size: name === bundle ? PAYLOAD.length : 100,
      digest: `sha256:${digest}`,
    });
    const index = [
      {
        tag_name: tag,
        draft: false,
        prerelease: tag.includes("-"),
        html_url: `https://releases.invalid/${tag}`,
        assets: [
          asset("latest.json", "c".repeat(64)),
          asset(feed, feedDigest),
          asset(bundle, DIGEST),
        ],
      },
    ];
    const files: Record<string, string> = {
      [`${base}/latest.json`]: latest,
      [`${base}/${feed}`]: feedText,
    };
    return { index, files, bundleUrl: `${base}/${bundle}`, version };
  }

  let requests: { url: string; ifNoneMatch: string | null }[];

  function serve(index: unknown, files: Record<string, string>, etag = '"v1"') {
    requests = [];
    vi.stubGlobal(
      "fetch",
      async (
        url: URL | string,
        init?: { headers?: Record<string, string> },
      ) => {
        const href = String(url);
        const ifNoneMatch = init?.headers?.["if-none-match"] ?? null;
        requests.push({ url: href, ifNoneMatch });
        if (href.startsWith(`${SOURCE}/releases`)) {
          if (ifNoneMatch === etag) return new Response(null, { status: 304 });
          return new Response(JSON.stringify(index), {
            status: 200,
            headers: { etag },
          });
        }
        const body = files[href];
        return body === undefined
          ? new Response("", { status: 404 })
          : new Response(body, { status: 200 });
      },
    );
  }

  beforeEach(() => {
    process.env.ARMADRA_UPDATER_SOURCE = SOURCE;
  });
  afterEach(() => {
    delete process.env.ARMADRA_UPDATER_SOURCE;
  });

  it("checks, then stays quiet for six hours, then asks with the ETag", async () => {
    const { index, files, bundleUrl } = await release();
    serve(index, files);
    const { controller } = await subject();
    const now = 1_800_000_000_000;

    const first = await controller.checkRelease({ nowMs: now });
    expect(first).toMatchObject({
      state: "available",
      offer: { version: "0.2.0", packageUrl: bundleUrl, sha256: DIGEST },
    });
    expect(requests[0]).toEqual({
      url: `${SOURCE}/releases?per_page=30`,
      ifNoneMatch: null,
    });

    // The timer firing again within the interval asks nothing at all.
    requests.length = 0;
    await controller.checkRelease({ nowMs: now + 60_000 });
    expect(requests).toEqual([]);

    // Past the interval it asks — conditionally, and a 304 reuses the answer.
    controller.dismiss();
    const later = await controller.checkRelease({
      nowMs: now + 6 * 60 * 60 * 1000 + 1,
    });
    expect(requests[0]).toEqual({
      url: `${SOURCE}/releases?per_page=30`,
      ifNoneMatch: '"v1"',
    });
    expect(later.state).toBe("available");
  });

  it("a person pressing check asks at once", async () => {
    const { index, files } = await release();
    serve(index, files);
    const { controller } = await subject();
    await controller.checkRelease({ nowMs: 1 });
    controller.dismiss();
    requests.length = 0;
    await controller.checkRelease({ manual: true, nowMs: 2 });
    expect(requests.length).toBeGreaterThan(0);
  });

  it("stable never offers a prerelease; beta does, and the cache is not shared", async () => {
    const { index, files } = await release({ tag: "v0.3.0-beta.1" });
    serve(index, files);
    const stable = await subject();
    expect(
      (await stable.controller.checkRelease({ manual: true, nowMs: 1 })).state,
    ).toBe("upToDate");

    const beta = await subject({
      settings: async () => '{"updates":{"channel":"beta"}}',
    });
    requests.length = 0;
    const state = await beta.controller.checkRelease({
      manual: true,
      nowMs: 2,
    });
    expect(state).toMatchObject({
      state: "available",
      offer: { version: "0.3.0-beta.1" },
    });
    // The stable answer's ETag is not offered for a beta question.
    expect(requests[0]?.ifNoneMatch).toBeNull();
  });

  it("a rollout this installation is outside of is no offer", async () => {
    const { index, files } = await release({
      rollout: { percent: 0, seed: "0.2.0" },
    });
    serve(index, files);
    const { controller } = await subject();
    expect(
      (await controller.checkRelease({ manual: true, nowMs: 1 })).state,
    ).toBe("upToDate");
    // The id that decided it is this installation's, kept for the next check.
    const id = readFileSync(join(directory, "updates", "install-id"), "utf8");
    expect(id.trim()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a rate-limited index is no answer, with the reset as the retry hint", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("", {
          status: 403,
          headers: {
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
          },
        }),
    );
    const { controller } = await subject();
    const state = await controller.checkRelease({ manual: true, nowMs: 1 });
    expect(state).toMatchObject({
      state: "unavailable",
      reason: "sourceUnreachable",
    });
    if (state.state !== "unavailable") return;
    expect(state.retryAfterMs).toBeGreaterThan(500_000);
  });

  it("downloads through this target's own feed, after checking it", async () => {
    const { index, files } = await release();
    serve(index, files);
    const { feedName, updaterChannel } = await import(
      "../../shell-core/updates/offer"
    );
    const own = await target();
    const { controller } = await subject();
    await controller.checkRelease({ manual: true, nowMs: 1 });
    const fake = updater as unknown as {
      channel?: string;
      allowDowngrade?: boolean;
    };
    fake.allowDowngrade = true;
    expect((await controller.download()).state).toBe("downloaded");
    expect(fake.channel).toBe(updaterChannel(own));
    // Setting a channel turns this on inside electron-updater; it is off again.
    expect(fake.allowDowngrade).toBe(false);
    expect(requests.some((r) => r.url.endsWith(`/${feedName(own)}`))).toBe(
      true,
    );
  });

  it("a feed that is not the one latest.json named stops the download", async () => {
    const { index, files } = await release({ feedDigest: "f".repeat(64) });
    serve(index, files);
    const { controller } = await subject();
    // The Host's digest for the feed disagrees with latest.json's: refused at
    // the check already.
    expect(
      await controller.checkRelease({ manual: true, nowMs: 1 }),
    ).toMatchObject({ state: "unavailable", reason: "digestMismatch" });
  });
});

/* ------------- the release key and the unsigned installers (#288) ---------- */

describe("a package carrying the release key (issue #288 §2)", () => {
  const NAME = "Armadra-0.2.0-arm64-mac.zip";

  /** A throwaway minisign key, in the files `tools/release/minisign.mjs` writes. */
  async function releaseKey() {
    const { generateKeyPairSync, randomBytes, sign } = await import(
      "node:crypto"
    );
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const keyId = randomBytes(8);
    const pub = `untrusted comment: minisign public key\n${Buffer.concat([
      Buffer.from("Ed"),
      keyId,
      der.subarray(der.length - 32),
    ]).toString("base64")}\n`;
    const signFile = (data: string, comment = `file:${NAME}`) => {
      const signature = sign(null, Buffer.from(data), privateKey);
      const global = sign(
        null,
        Buffer.concat([signature, Buffer.from(comment)]),
        privateKey,
      );
      return [
        "untrusted comment: signature from armadra release key",
        Buffer.concat([Buffer.from("Ed"), keyId, signature]).toString("base64"),
        `trusted comment: ${comment}`,
        global.toString("base64"),
        "",
      ].join("\n");
    };
    return { pub, signFile };
  }

  /** Serves the feed, the bundle and (unless told otherwise) its signature. */
  function serveRelease(signature: string | null) {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: URL | string) => {
      const href = String(url);
      asked.push(href);
      if (href === `${RELEASE}/latest-darwin-aarch64-mac.yml`) {
        return new Response(FEED, { status: 200 });
      }
      if (href === BUNDLE) {
        return new Response(PAYLOAD, {
          status: 200,
          headers: { "content-length": String(PAYLOAD.length) },
        });
      }
      if (href === `${BUNDLE}.sig` && signature !== null) {
        return new Response(signature, { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    return asked;
  }

  interface Recorded {
    staged: [string, string, string][];
    helpers: unknown[];
    installers: string[];
    quits: number;
  }

  function fakeInstallers(
    options: { replaceable?: boolean; stage?: "ok" | "sourceMalformed" } = {},
  ) {
    const recorded: Recorded = {
      staged: [],
      helpers: [],
      installers: [],
      quits: 0,
    };
    const installers: Installers = {
      stageMacBundle: async (zip, version, workDir) => {
        recorded.staged.push([zip, version, workDir]);
        return options.stage === "sourceMalformed"
          ? { ok: false, reason: "sourceMalformed" }
          : { ok: true, value: join(workDir, "new", "Armadra.app") };
      },
      replaceable: () => options.replaceable ?? true,
      launchMacHelper: (input) => {
        recorded.helpers.push(input);
        return { ok: true, value: undefined };
      },
      launchWindowsInstaller: (installer) => {
        recorded.installers.push(installer);
        return { ok: true, value: undefined };
      },
      quit: () => {
        recorded.quits += 1;
      },
    };
    return { installers, recorded };
  }

  function keyed(
    pub: string,
    overrides: Partial<UpdaterEnvironment> = {},
  ): () => UpdaterEnvironment {
    return () => ({
      packaged: true,
      marker: undefined,
      publishConfigured: true,
      signature: "unsigned",
      developmentOverride: true,
      platform: "darwin",
      pubkey: pub,
      managed: null,
      ...overrides,
    });
  }

  it("unsigned macOS: downloads itself, verifies digest and signature, hands over to the helper", async () => {
    const key = await releaseKey();
    const asked = serveRelease(key.signFile(PAYLOAD));
    const { installers, recorded } = fakeInstallers();
    updater.feed = null;
    const notices: string[] = [];
    const announcements: unknown[] = [];
    const { controller } = await subject({
      environment: keyed(key.pub),
      installers,
      appBundle: () => "/Applications/Armadra.app",
      notify: (_title, body) => notices.push(body),
      locale: () => "zhCn",
    });
    controller.onStaged((staged) => announcements.push(staged));
    await controller.check(verdict());
    expect((await controller.download()).state).toBe("downloaded");
    // electron-updater was not involved; the shell fetched the bundle and its .sig.
    expect(updater.feed).toBeNull();
    expect(asked).toContain(BUNDLE);
    expect(asked).toContain(`${BUNDLE}.sig`);
    const file = join(directory, "updates", "download", NAME);
    expect(readFileSync(file, "utf8")).toBe(PAYLOAD);
    // The tray and the notification both say a restart will install it.
    expect(announcements).toEqual([
      { ready: true, version: "0.2.0", installable: true },
    ]);
    expect(notices).toEqual(["重启 Armadra 即可更新到 0.2.0。"]);

    let stops = 0;
    runtimeStops = async () => {
      stops += 1;
    };
    const state = await controller.install();
    expect(state).toMatchObject({ state: "downloaded", phase: "installing" });
    const work = join(directory, "updates", "install");
    expect(recorded.staged).toEqual([[file, "0.2.0", work]]);
    expect(stops).toBe(1);
    expect(recorded.helpers).toEqual([
      {
        pid: process.pid,
        installed: "/Applications/Armadra.app",
        replacement: join(work, "new", "Armadra.app"),
        workDir: work,
      },
    ]);
    expect(restarts).toBe(1);
    expect(recorded.quits).toBe(1);
    expect(updater.installs).toBe(0);
    // The restart report has what it needs on the next start.
    expect(
      JSON.parse(
        readFileSync(
          join(directory, "updates", "pending-restart.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ expectedVersion: "0.2.0", previousVersion: "0.1.0" });
  });

  it("unsigned macOS: a bundle that cannot be replaced or unpacked stops nothing", async () => {
    const key = await releaseKey();
    serveRelease(key.signFile(PAYLOAD));
    for (const options of [
      { replaceable: false },
      { stage: "sourceMalformed" as const },
    ]) {
      const { installers, recorded } = fakeInstallers(options);
      const { controller } = await subject({
        environment: keyed(key.pub),
        installers,
        appBundle: () => "/Applications/Armadra.app",
      });
      await controller.check(verdict());
      await controller.download();
      let stops = 0;
      runtimeStops = async () => {
        stops += 1;
      };
      expect(await controller.install()).toMatchObject({
        state: "downloaded",
        phase: "ready",
        problem:
          options.replaceable === false ? "installFailed" : "sourceMalformed",
      });
      expect(stops).toBe(0);
      expect(recorded.quits).toBe(0);
      expect(recorded.helpers).toEqual([]);
    }
  });

  it("unsigned Windows: runs the verified installer and quits", async () => {
    const key = await releaseKey();
    serveRelease(key.signFile(PAYLOAD));
    const { installers, recorded } = fakeInstallers();
    const { controller } = await subject({
      environment: keyed(key.pub, { platform: "win32" }),
      installers,
    });
    await controller.check(verdict());
    expect((await controller.download()).state).toBe("downloaded");
    await controller.install();
    expect(recorded.installers).toEqual([
      join(directory, "updates", "download", NAME),
    ]);
    expect(recorded.staged).toEqual([]);
    expect(recorded.quits).toBe(1);
    expect(updater.installs).toBe(0);
  });

  it("signed: electron-updater installs, and the signature is still checked", async () => {
    const key = await releaseKey();
    const asked = serveRelease(key.signFile(PAYLOAD));
    const { installers, recorded } = fakeInstallers();
    const { controller } = await subject({
      environment: keyed(key.pub, { signature: "signed" }),
      installers,
    });
    await controller.check(verdict());
    expect((await controller.download()).state).toBe("downloaded");
    expect(asked).toContain(`${BUNDLE}.sig`);
    expect(asked).not.toContain(BUNDLE);
    await controller.install();
    expect(updater.installs).toBe(1);
    expect(recorded.quits).toBe(0);
  });

  it("a missing, foreign or mislabelled signature is refused on every path", async () => {
    const ours = await releaseKey();
    const theirs = await releaseKey();
    const cases: [string | null, Partial<UpdaterEnvironment>][] = [
      [null, {}],
      [theirs.signFile(PAYLOAD), {}],
      [ours.signFile("other bytes"), {}],
      [ours.signFile(PAYLOAD, "file:SHA256SUMS"), {}],
      [theirs.signFile(PAYLOAD), { signature: "signed" }],
      [null, { platform: "win32" }],
    ];
    for (const [signature, overrides] of cases) {
      serveRelease(signature);
      const { installers } = fakeInstallers();
      const { controller } = await subject({
        environment: keyed(ours.pub, overrides),
        installers,
      });
      await controller.check(verdict());
      expect(await controller.download()).toMatchObject({
        state: "failed",
        reason: "signatureMismatch",
      });
    }
  });

  it("bytes that are not the published ones are refused before the signature is asked", async () => {
    const key = await releaseKey();
    const asked = serveRelease(key.signFile(PAYLOAD));
    const { installers } = fakeInstallers();
    const tampered = verdict();
    tampered.answer.artifacts[1]!.sha256 = "0".repeat(64);
    const { controller } = await subject({
      environment: keyed(key.pub),
      installers,
    });
    await controller.check(tampered);
    expect(await controller.download()).toMatchObject({
      state: "failed",
      reason: "digestMismatch",
    });
    expect(asked).not.toContain(`${BUNDLE}.sig`);
    expect(existsSync(join(directory, "updates", "download"))).toBe(false);
  });
});

describe("a package someone else owns (issue #288 §2)", () => {
  const SOURCE = "http://127.0.0.1:8123/repos/o/r";

  beforeEach(() => {
    process.env.ARMADRA_UPDATER_SOURCE = SOURCE;
  });
  afterEach(() => {
    delete process.env.ARMADRA_UPDATER_SOURCE;
  });

  it("stays unsupported and learns which installer to download", async () => {
    const { shellTarget } = await import("../../shell-core/updates/offer");
    const own = shellTarget(process.platform, process.arch);
    if (own === null) return;
    const kind = own.startsWith("darwin-")
      ? "dmg"
      : own.startsWith("windows-")
        ? "portable"
        : "deb";
    const name = own.startsWith("darwin-")
      ? `Armadra_0.2.0_${own}.dmg`
      : own.startsWith("windows-")
        ? `Armadra_0.2.0_${own}-portable.zip`
        : `Armadra_0.2.0_${own}.deb`;
    const url = `https://github.com/AMA-Link/Armadra/releases/download/v0.2.0/${name}`;
    vi.stubGlobal("fetch", async (href: URL | string) =>
      String(href).startsWith(`${SOURCE}/releases`)
        ? new Response(
            JSON.stringify([
              {
                tag_name: "v0.2.0",
                draft: false,
                prerelease: false,
                html_url:
                  "https://github.com/AMA-Link/Armadra/releases/tag/v0.2.0",
                assets: [
                  {
                    name,
                    browser_download_url: url,
                    size: 1,
                    digest: `sha256:${"a".repeat(64)}`,
                  },
                ],
              },
            ]),
            { status: 200 },
          )
        : new Response("", { status: 404 }),
    );
    const { controller } = await subject({
      environment: () => ({
        packaged: true,
        marker: undefined,
        publishConfigured: true,
        signature: "unsigned",
        developmentOverride: true,
        platform: process.platform,
        pubkey: "untrusted comment: x\nRWQ\n",
        managed: kind,
      }),
    });
    expect(controller.state()).toEqual({
      state: "unsupported",
      reason: "managedPackage",
      managed: { package: kind, download: null },
    });
    expect(await controller.checkRelease({ manual: true, nowMs: 1 })).toEqual({
      state: "unsupported",
      reason: "managedPackage",
      managed: {
        package: kind,
        download: {
          version: "0.2.0",
          url,
          notesUrl: "https://github.com/AMA-Link/Armadra/releases/tag/v0.2.0",
        },
      },
    });
    // Nothing can be downloaded or installed through the shell.
    expect((await controller.download()).state).toBe("unsupported");
    expect((await controller.install()).state).toBe("unsupported");
  });
});
