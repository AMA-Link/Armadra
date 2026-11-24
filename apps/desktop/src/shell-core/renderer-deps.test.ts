import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { copyWebDist, resolveReuseWebDist } from "../../electron.vite.config";

/**
 * The renderer target in `electron.vite.config.ts` imports `apps/web`'s own
 * Vite config, so the shell builds the front end exactly one way. electron-vite
 * bundles that config into a temporary module inside `apps/desktop`, which
 * means apps/web's build plugins have to resolve from HERE too.
 *
 * Listing them twice is the cost of that. This test is what keeps the second
 * list honest: a version bump in apps/web that is not mirrored here would
 * otherwise let the desktop bundle quietly diverge from the web bundle, and
 * the only symptom would be a packaged app that renders differently from the
 * one the front-end tests ran against.
 */
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "../..");

function devDependencies(manifest: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return parsed.devDependencies ?? {};
}

const SHARED = [
  "vite",
  "@vitejs/plugin-react",
  "@tailwindcss/vite",
  "tailwindcss",
] as const;

describe("the renderer build toolchain", () => {
  const desktop = devDependencies(join(app, "package.json"));
  const web = devDependencies(join(app, "../web/package.json"));

  it("is pinned to exactly the versions apps/web builds with", () => {
    for (const name of SHARED) {
      expect(web[name], `apps/web no longer declares ${name}`).toBeDefined();
      expect(desktop[name], name).toBe(web[name]);
    }
  });
});

describe("ARMADRA_REUSE_WEB_DIST", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "armadra-web-reuse-"));
    dirs.push(dir);
    return dir;
  }

  it("stays off in serve mode or when ARMADRA_REUSE_WEB_DIST is unset", () => {
    const webRoot = makeTempDir();
    expect(resolveReuseWebDist("build", {}, webRoot)).toBe(false);
    expect(
      resolveReuseWebDist("serve", { ARMADRA_REUSE_WEB_DIST: "1" }, webRoot),
    ).toBe(false);
  });

  it("throws fast when ARMADRA_REUSE_WEB_DIST=1 is set without dist/index.html", () => {
    const webRoot = makeTempDir();
    expect(() =>
      resolveReuseWebDist("build", { ARMADRA_REUSE_WEB_DIST: "1" }, webRoot),
    ).toThrow(/ARMADRA_REUSE_WEB_DIST=1/);
  });

  it("enables reuse and copies dist into out/renderer when dist/index.html exists", () => {
    const webRoot = makeTempDir();
    const from = join(webRoot, "dist");
    const to = join(makeTempDir(), "out/renderer");
    mkdirSync(join(from, "assets"), { recursive: true });
    writeFileSync(join(from, "index.html"), "<!doctype html><title>ok</title>");
    writeFileSync(join(from, "assets/main.js"), "console.log(1);");

    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "stale.js"), "old");

    expect(
      resolveReuseWebDist("build", { ARMADRA_REUSE_WEB_DIST: "1" }, webRoot),
    ).toBe(true);
    copyWebDist(from, to);

    expect(readFileSync(join(to, "index.html"), "utf8")).toContain(
      "<title>ok</title>",
    );
    expect(readFileSync(join(to, "assets/main.js"), "utf8")).toBe(
      "console.log(1);",
    );
    expect(() => readFileSync(join(to, "stale.js"), "utf8")).toThrow();
  });
});
