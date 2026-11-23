#!/usr/bin/env node
/**
 * Renders the macOS install window background to `build/background.png` and
 * `build/background@2x.png`. The PNGs are committed, so packaging never needs
 * a browser; rerun this only when the artwork changes:
 *
 *   node apps/desktop/scripts/render-dmg-background.mjs
 *
 * A disk image holds one fixed background and Finder has no per-appearance
 * variant, so the artwork stays light: it has to carry Finder's dark file names
 * in both system appearances.
 *
 * WINDOW and the icon row must match the `dmg` section of electron-builder.yml.
 * AGENTS is the built-in list in packages/shared/src/agents.ts; each logo is in
 * `build/dmg-logos/`, and `ama` uses the Armadra icon.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BUILD = resolve(dirname(fileURLToPath(import.meta.url)), "../build");

const WINDOW = { width: 660, height: 440 };
const ORBIT = { x: 330, y: 205, rx: 300, ry: 176 };
const BADGE = 50;

// `angle` is degrees clockwise from the right, chosen to keep every badge clear
// of the icons and of the file names Finder draws under them. `fill` logos carry
// their own ground and cover the badge; `scale` evens out their optical size.
const AGENTS = [
  { file: "dmg-logos/claude.svg", angle: -152, scale: 0.56 },
  { file: "dmg-logos/codex.svg", angle: -118, scale: 0.65 },
  { file: "dmg-logos/opencode.svg", angle: -62, scale: 0.54 },
  { file: "dmg-logos/copilot.svg", angle: -20, scale: 0.58 },
  { file: "dmg-logos/pi.svg", angle: 150, scale: 0.81 },
  { file: "dmg-logos/omp.svg", angle: 90, scale: 1.02, fill: true },
  { file: "icons/icon.png", angle: 32, scale: 1.26, fill: true },
];

function badge({ file, angle, scale }) {
  const radians = (angle * Math.PI) / 180;
  const left = ORBIT.x + ORBIT.rx * Math.cos(radians) - BADGE / 2;
  const top = ORBIT.y + ORBIT.ry * Math.sin(radians) - BADGE / 2;
  const size = BADGE * scale;
  const src = pathToFileURL(join(BUILD, file)).href;
  return `<div class="badge" style="left:${left.toFixed(2)}px;top:${top.toFixed(2)}px">
    <img src="${src}" style="width:${size}px;height:${size}px" alt="">
  </div>`;
}

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${WINDOW.width}px;height:${WINDOW.height}px;overflow:hidden;
  background:radial-gradient(70% 70% at 50% 47%,#fff 0,#f6f3ec 72%,#ece7dc 100%)}
svg{position:absolute;left:0;top:0}
.badge{position:absolute;width:${BADGE}px;height:${BADGE}px;overflow:hidden;border-radius:50%;background:#fff;
  box-shadow:0 0 0 .5px rgba(45,35,25,.12),0 6px 16px rgba(45,35,25,.14)}
.badge img{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
.hint{position:absolute;left:230px;width:200px;top:226px;text-align:center;
  font:500 12.5px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:#77715f}
</style>
<svg width="${WINDOW.width}" height="${WINDOW.height}" fill="none" stroke="#d9d2c4">
  <ellipse cx="${ORBIT.x}" cy="${ORBIT.y}" rx="${ORBIT.rx}" ry="${ORBIT.ry}"/>
  <ellipse cx="${ORBIT.x}" cy="${ORBIT.y}" rx="252" ry="134" stroke-dasharray="2 6" stroke-linecap="round"/>
</svg>
${AGENTS.map(badge).join("")}
<svg width="${WINDOW.width}" height="${WINDOW.height}" fill="none" stroke="#2a2825" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M264 204 Q330 168 394 200"/>
  <path d="M388.3 189.4 L394 200 L382.1 201.8"/>
</svg>
<div class="hint">Drag to Applications</div>`;

const work = mkdtempSync(join(tmpdir(), "armadra-dmg-background-"));
try {
  const page = join(work, "background.html");
  writeFileSync(page, html);
  for (const [scale, file] of [
    [1, "background.png"],
    [2, "background@2x.png"],
  ]) {
    const result = spawnSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--allow-file-access-from-files",
        `--user-data-dir=${join(work, "profile")}`,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${WINDOW.width},${WINDOW.height}`,
        `--screenshot=${join(BUILD, file)}`,
        pathToFileURL(page).href,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`Chrome failed for ${file}: ${result.stderr}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
