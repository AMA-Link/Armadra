// 桌面壳添加中转账号时的人机验证（契约 §62.2，Armadra#266）。
//
//   node tools/probes/relay-challenge-desktop.mjs [--workerd] [输出目录]
//
// 起两台本地个人中转与一个隔离的开发构建 Electron（临时数据目录、HOME 与 profile，
// mock 钥匙串），在「设置 → 远程访问」里走真实的添加流程。中继缺省是 Go 版（找法见
// `cloud-source.mjs`，回环明文 `--tls plain`，数据目录在临时目录里）；`--workerd` 换成本地
// workerd 上的 Workers 中继（armadra-cloud 的 apps/relay-workers，`wrangler dev --local`，
// 不连 Cloudflare 账号）。
//
//   1. 中继不声明挑战：直接登录成功，全程不出现验证面板；
//   2. 中继配了 Cloudflare 官方测试站点密钥（总是通过）：验证面板里内嵌中继的
//      `/app/challenge`——页面来源 `http://127.0.0.1:<端口>` 在中继的 `frame-ancestors`
//      里，挑战页报 `ready` 后 iframe 才显示，期间 iframe 不重挂；令牌只从中继来源交回，
//      面板带着令牌重提交。测试密钥的 siteverify 答案没有 `action`，中继按规矩判
//      `challenge_invalid`，页面给一次错误提示、验证面板关掉，不循环。
//
// 前提：`pnpm --filter @armadra/web build`、`pnpm --filter @armadra/desktop build`，以及
// 中继（Go 二进制或 armadra-cloud 的本地检出，见 `cloud-source.mjs`）。产物：result.json 与每一步的截图。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  NO_CLOUD_HINT,
  NO_RELAY_HINT,
  findCloudSource,
  relayAvailable,
} from "./cloud-source.mjs";
import { spawnRelay } from "./platform-lib.mjs";
import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { attachRenderer } from "./relay-desktop.mjs";
import { freePort, root, sleep, until } from "./ui-features/harness.mjs";
import { startWorkerd } from "./workerd-relay.mjs";

/** Cloudflare 公开的测试密钥：总是通过、不连任何账号。 */
const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET = "1x0000000000000000000000000000000AA";

const useWorkerd = process.argv.includes("--workerd");
const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/relay-challenge-desktop"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const cloudHome = findCloudSource();
if (useWorkerd ? !cloudHome : !relayAvailable(cloudHome)) {
  console.error(useWorkerd ? NO_CLOUD_HINT : NO_RELAY_HINT);
  process.exit(2);
}
const webRoot = join(root, "apps/web/dist");
for (const [file, hint] of [
  [join(webRoot, "index.html"), "pnpm --filter @armadra/web build"],
  [
    join(root, "apps/desktop/out/main/index.js"),
    "pnpm --filter @armadra/desktop build",
  ],
])
  if (!existsSync(file)) {
    console.error(`先 ${hint}`);
    process.exit(2);
  }

const report = { status: "failed", output, steps: [] };
const ok = (name, detail) => {
  report.steps.push({ name, detail });
  console.log(
    `ok - ${name}${detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`,
  );
};

const relays = [];
let app;
let page;
let log = "";
const scratch = mkdtempSync(join(tmpdir(), "armadra-challenge-probe-"));
const home = probeHome("armadra-challenge-probe-home-");

/**
 * Go 版个人中转：init 后 serve，回环明文（`--tls plain`，issuer `http://127.0.0.1:<端口>`，
 * 与 workerd 同形）；`challenge` 时配 Turnstile 的官方测试站点密钥。答与 `startWorkerd` 同形的
 * `{ issuer, account, password, stop() }`；`stop` 只结束自己起的进程。
 */
async function startGoRelay({ challenge = false } = {}) {
  const dir = mkdtempSync(join(scratch, "relay-"));
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const account = "dev";
  const password = `${randomBytes(12).toString("base64url")}-Aq7`;
  const passwordFile = join(dir, "password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const common = [
    "--data-dir",
    join(dir, "data"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--tls",
    "plain",
    "--public-origin",
    issuer,
  ];
  const init = spawnRelay(cloudHome, [
    "init",
    ...common,
    "--account",
    account,
    "--password-file",
    passwordFile,
  ]);
  const code = await new Promise((done) => init.child.once("exit", done));
  if (code !== 0) throw new Error(`personal init 失败：${init.log()}`);
  const extra = [];
  if (challenge) {
    const secretFile = join(dir, "turnstile-secret");
    writeFileSync(secretFile, TEST_SECRET, { mode: 0o600 });
    // 测试密钥的 siteverify 答案里 hostname 是 example.com。
    extra.push(
      "--challenge",
      "turnstile",
      "--turnstile-site-key",
      TEST_SITE_KEY,
      "--turnstile-secret-file",
      secretFile,
      "--turnstile-hostnames",
      "example.com",
    );
  }
  const serve = spawnRelay(cloudHome, [
    "serve",
    ...common,
    "--listen",
    `127.0.0.1:${port}`,
    "--web-root",
    webRoot,
    ...extra,
  ]);
  const stop = async () => {
    if (serve.child.exitCode !== null) return;
    serve.child.kill("SIGTERM");
    for (let i = 0; i < 50 && serve.child.exitCode === null; i += 1)
      await sleep(100);
    if (serve.child.exitCode === null) serve.child.kill("SIGKILL");
  };
  try {
    await until(
      async () => {
        if (serve.child.exitCode !== null)
          throw new Error(`中继退出：${serve.log()}`);
        const answer = await fetch(`${issuer}/.well-known/armadra-platform`);
        return answer.status === 200 || null;
      },
      "Go 中继起来",
      { timeout: 30_000, every: 200 },
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { issuer, account, password, log: serve.log, stop };
}

const visibleDialogs = `return [...document.querySelectorAll('[role=dialog]')].map((d) => d.querySelector('h2')?.textContent ?? '')`;

async function openAddRelay() {
  // 「添加中转账号」在远程访问页的「高级」里（#301）：先展开。
  await page.evaluate(
    `const more = [...document.querySelectorAll('button[aria-expanded="false"]')]
       .find((b) => /^(高级|Advanced)$/.test(b.textContent.trim()));
     more?.click();
     return true;`,
  );
  await page.clickOn(
    `const buttons = [...document.querySelectorAll('button')].filter((b) => !b.closest('form'));
     const named = (pattern) => buttons.find((b) => pattern.test(b.textContent.trim()));
     return named(/^(添加中转账号|Add remote access account)$/) ?? named(/^(添加|Add)$/);`,
    "「添加中转账号」",
  );
  await page.until(
    `return document.getElementById('remote-issuer') ? true : null`,
    "添加中转账号的表单",
    { timeout: 15_000 },
  );
}

async function fillAndSubmit(relay) {
  for (const [id, value] of [
    ["remote-issuer", relay.issuer],
    ["remote-account", relay.account],
    ["remote-password", relay.password],
  ]) {
    await page.clickOn(`return document.getElementById('${id}')`, id);
    await page.type(value);
  }
  await page.enter();
}

try {
  // 1 与 2 的两台中继；第二台配官方测试站点密钥。
  if (useWorkerd) {
    relays.push(await startWorkerd({ cloudHome, webRoot }));
    relays.push(
      await startWorkerd({
        cloudHome,
        webRoot,
        vars: {
          RELAY_TURNSTILE_SECRET: TEST_SECRET,
          RELAY_TURNSTILE_SITE_KEY: TEST_SITE_KEY,
          // 测试密钥的 siteverify 答案里 hostname 是 example.com。
          RELAY_TURNSTILE_HOSTNAMES: "example.com",
        },
      }),
    );
  } else {
    relays.push(await startGoRelay());
    relays.push(await startGoRelay({ challenge: true }));
  }
  const [plain, guarded] = relays;
  const declared = async (relay) =>
    (await (await fetch(`${relay.issuer}/.well-known/armadra-platform`)).json())
      .challenge ?? null;
  if ((await declared(plain)) !== null)
    throw new Error("没配 Turnstile 的中继却声明了挑战");
  if ((await declared(guarded))?.siteKey !== TEST_SITE_KEY)
    throw new Error("配了测试站点密钥的中继没声明挑战");
  ok(
    `两台本地${useWorkerd ? " workerd" : " Go"} 中继：一台不声明挑战，一台声明测试站点密钥`,
  );

  const require = createRequire(join(root, "apps/desktop/package.json"));
  const port = await freePort();
  app = spawn(
    require("electron"),
    [
      join(root, "apps/desktop"),
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${join(scratch, "electron")}`,
      "--use-mock-keychain",
    ],
    {
      env: isolatedEnv(home, {
        ARMADRA_DATA_DIR: scratch,
        ARMADRA_DESKTOP_OWNS_RUNTIME: "1",
        ARMADRA_RUNTIME_PORT: String(await freePort()),
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_NO_GLOBAL_WRITES: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const take = (chunk) => (log = (log + chunk).slice(-32_768));
  app.stdout.on("data", take);
  app.stderr.on("data", take);
  page = await attachRenderer(port, () => log);
  const pageOrigin = await page.evaluate(`return location.origin`);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(pageOrigin))
    throw new Error(`桌面页面来源不是回环：${pageOrigin}`);

  // 设置停在「远程访问」，用快捷键（Mod+,）打开。
  await page.evaluate(
    `localStorage.setItem("armadra.settingsSection", "remoteAccess"); return true;`,
  );
  await page.call("Page.reload", {});
  await sleep(1_500);
  await page.until(
    `return !document.getElementById("splash-root") && document.readyState === "complete"`,
    "页面就绪",
    { timeout: 60_000 },
  );
  const modifiers = process.platform === "darwin" ? 4 : 2;
  for (const type of ["keyDown", "keyUp"])
    await page.call("Input.dispatchKeyEvent", {
      type,
      key: ",",
      code: "Comma",
      modifiers,
      windowsVirtualKeyCode: 188,
    });
  await sleep(800);

  /* --------------------- 1. 中继不声明挑战：不弹验证 --------------------- */
  await page.evaluate(`
    window.__challengeSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('iframe[src*="/app/challenge"]')) window.__challengeSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
    return true;`);
  await openAddRelay();
  await fillAndSubmit(plain);
  await page.until(
    `return document.getElementById('remote-issuer') ? null : true`,
    "不声明挑战的中继：登录完成、表单关闭",
    { timeout: 30_000 },
  );
  if (await page.evaluate(`return window.__challengeSeen`))
    throw new Error("中继没声明挑战，桌面端却弹了验证面板");
  ok("中继不声明挑战：直接登录，不弹验证面板");
  await page.capture(join(output, "01-plain-added.png"));

  /* ---------------- 2. 测试站点密钥：内嵌挑战页，不闪、不循环 ---------------- */
  await page.evaluate(`
    window.__frames = 0;
    window.__messages = [];
    addEventListener('message', (e) => window.__messages.push({ origin: e.origin, data: e.data }));
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1 && (node.tagName === 'IFRAME' || node.querySelector?.('iframe[src*="/app/challenge"]')))
            window.__frames += 1;
    }).observe(document.body, { childList: true, subtree: true });
    return true;`);
  await openAddRelay();
  await fillAndSubmit(guarded);
  const frame = await page.until(
    `const f = document.querySelector('iframe[src*="/app/challenge"]');
     return f ? { src: f.src } : null;`,
    "验证面板内嵌中继的挑战页",
    { timeout: 30_000 },
  );
  const src = new URL(frame.src);
  if (
    src.origin !== guarded.issuer ||
    src.searchParams.get("parent") !== pageOrigin
  )
    throw new Error(`挑战页地址不对：${frame.src}`);
  // 被 frame-ancestors 拦下时挑战页不会报到，面板停在加载、随后给「加载失败」。
  await page.until(
    `return window.__messages.some((m) => m.origin === ${JSON.stringify(guarded.issuer)} && m.data?.status === 'ready') || null`,
    "挑战页在桌面窗口里载入并报 ready（没被 frame-ancestors 拦下）",
    { timeout: 30_000 },
  );
  ok("挑战页在桌面窗口里载入", { parent: pageOrigin });
  await page.capture(join(output, "02-challenge.png")).catch(() => undefined);
  await page.until(
    `return window.__messages.some((m) => m.origin === ${JSON.stringify(guarded.issuer)} && typeof m.data?.token === 'string') || null`,
    "测试站点密钥交回令牌",
    { timeout: 30_000 },
  );
  ok("令牌从中继来源经 postMessage 交回");
  // 测试密钥的答案没有 action：中继判 challenge_invalid，页面给一次错误。
  const alert = await page.until(
    `const form = document.getElementById('remote-issuer')?.closest('form');
     const text = form?.querySelector('[data-slot=field-error], [role=alert]')?.textContent ?? '';
     return text || null;`,
    "重提交后页面给出结果",
    { timeout: 30_000 },
  );
  await sleep(3_000);
  const frames = await page.evaluate(`return window.__frames`);
  const stillOpen = await page.evaluate(
    `return !!document.querySelector('iframe[src*="/app/challenge"]')`,
  );
  if (frames !== 1)
    throw new Error(
      `挑战页 iframe 挂了 ${frames} 次（应为 1，多了就是重载循环）`,
    );
  if (stillOpen) throw new Error("拿到令牌后验证面板没有关掉");
  ok("iframe 只挂一次、拿到令牌即关；中继判测试令牌无效，提示一次", {
    alert,
    dialogs: await page.evaluate(visibleDialogs),
  });
  await page.capture(join(output, "03-after-token.png"));
  if (page.problems.length > 0)
    throw new Error(`页面异常：${page.problems.slice(0, 3).join(" | ")}`);
  ok("桌面页面无异常");
  report.status = "passed";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`not ok - ${report.error}`);
  if (page)
    await page.capture(join(output, "zz-failure.png")).catch(() => undefined);
  report.electronLog = log.slice(-4_000);
} finally {
  page?.close();
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    for (let i = 0; i < 50 && app.exitCode === null; i += 1) await sleep(100);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  for (const relay of relays) await relay.stop().catch(() => undefined);
  home.remove();
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
}
process.exit(report.status === "passed" ? 0 : 1);
