// 控制台 `/h/<hostId>` 对一个已有 SaaS 部署的端到端探针（设计 saas-host-open §8.1：E2–E6、E8）。
//
// 连一个已经在跑的 Armadra 云部署（控制面 + 中继节点），起一台临时数据目录的服务器壳当 host1
// （设备码登录到 owner 的账号、登记到团队、owner 映射为本机主人），再用新 profile 的无头 Chrome
// 开两个互相隔离的 browser context（owner、member）：
//
//   E2 owner 从控制台打开 `/h/<host1>?ws=…`：新设备停在待确认，主机放行后进画布、终端收发；
//   E3 刷新三次不再待确认、不新增主机侧会话；复制标签页（连同 sessionStorage）照样能用；
//   E4 停 host1 再起来：页面自己回到画布；强制重建中继节点后终端照常；
//   E5 member（driver）打开 `/h/`，owner 把授予改成只读：member 的终端不再能写；连改三次授予，
//      member 的重登不超过 2 次；
//   E6 撤销 member 的授予：member 的 `/h/` 盖上「没有权限」；owner 另一个标签页里控制台登出：
//      owner 的 `/h/` 显示已登出、host1 上 owner 的会话已吊销。
//   E7（只在 ARMADRA_SAAS_ONLY 点名时跑，缺省不跑）控制台背书与浏览器背书的限制（设计 §5、Q14）：
//      E2 之前 member 打开 `/h/` 停在待确认，owner 的信任页对这行给「在此浏览器打开主机」；E2 里 owner
//      的 `/h/` 进了主机，信任页不刷新就改给「信任」（`armadra.e2e.trust` 广播）；owner 在信任页输入
//      member 屏幕上的码 → member 自动进入，host1 记成 `endorse:`、owner 的 `/h/` 弹背书通知；
//      owner 另一个浏览器的待确认，owner 的受信浏览器批它答 forbidden；经它「配对新设备」答 forbidden。
//      E7c（#607）背书进需要人处理，见 saas-host-e2e-notices.mjs。
//   E10（只在点名时跑；会让 host1 登出 Armadra 云，别与 E5、E6 同跑）控制台「新建链接」，见 saas-host-e2e-link.mjs。
//   E8 host1 经 SaaS 路线建一条只读链接；没登录的新 browser context 打开：落地页「加入」后地址是
//      `/h/<host1>`、刷新仍在画布（经访客记录续上，不去登录）；撤销链接后 `/h/` 显示「访问已被收回」。
//
// 全程在页面加载前监听 `securitypolicyviolation`（含 Trusted Types），要求违规为零。控制台页面的 CSP
// 缺省换成 B7 要提的那一份（控制面现有的原样加 `img-src` / `media-src` 的 `blob:` 与设计 Q13 的
// `require-trusted-types-for 'script'`）；`ARMADRA_SAAS_CSP=current` 不换，看控制面现在的 CSP。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/web build && pnpm --filter @armadra/server build
//   # 控制台页面：部署挂上这份 apps/web/dist，或给 ARMADRA_SAAS_WEB_ROOT=apps/web/dist 由探针答（不改部署）
//   NODE_EXTRA_CA_CERTS=<ca.crt> \
//   ARMADRA_SAAS_ISSUER=https://app.saas.localhost \
//   ARMADRA_SAAS_SPKI=<leaf.spki 的内容> \
//   ARMADRA_SAAS_ACCOUNTS=<accounts.json：{ owner, member } 各 { email, password }> \
//   ARMADRA_SAAS_TEAM=test-team \
//   [ARMADRA_SAAS_COMPOSE="<compose 包装脚本>"]  # 给了才做 E4 的节点重建
//   [ARMADRA_SAAS_ONLY=E2,E6,E8] [ARMADRA_SAAS_CSP=current]
//   node tools/probes/saas-host-e2e.mjs [输出目录]
//
// 服务器壳与 Chrome 只按自己起的 PID 停；数据目录、HOME、profile 都是 mktemp 出来的，跑完删除。
// 产物默认在 target/saas-host-e2e/：result.json 与截图。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import {
  SAS_ON_PAGE,
  nodeAt,
  terminalRoundTrip,
  untilApproved,
} from "./platform-lib.mjs";
import { probeSession } from "./probe-session.mjs";
import { runGuestLink } from "./saas-host-e2e-guest.mjs";
import { runNewLink } from "./saas-host-e2e-link.mjs";
import { endorsementNotices } from "./saas-host-e2e-notices.mjs";
import {
  connectBrowser,
  freePort,
  makeNode,
  root,
  scenario,
  sleep,
  until,
  writeResult,
} from "./ui-features/harness.mjs";

const output = resolve(process.argv[2] ?? join(root, "target/saas-host-e2e"));
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const ISSUER = (
  process.env.ARMADRA_SAAS_ISSUER ?? "https://app.saas.localhost"
).replace(/\/+$/, "");
const accountsFile = process.env.ARMADRA_SAAS_ACCOUNTS;
const SPKI = process.env.ARMADRA_SAAS_SPKI ?? "";
const TEAM = process.env.ARMADRA_SAAS_TEAM ?? "test-team";
const COMPOSE = process.env.ARMADRA_SAAS_COMPOSE ?? "";
/** 只跑其中几步（逗号分隔，如 `E2,E6`）；缺省全跑。 */
const ONLY = new Set(
  (process.env.ARMADRA_SAAS_ONLY ?? "E2,E3,E4,E5,E6,E8").split(","),
);
if (!accountsFile || !existsSync(accountsFile)) {
  console.error("要 ARMADRA_SAAS_ACCOUNTS（{ owner, member } 的邮箱与口令）");
  process.exit(2);
}
const accounts = JSON.parse(readFileSync(accountsFile, "utf8"));
const webRoot = join(root, "apps/web/dist");
const serverMain = join(root, "apps/server/out/main.js");
for (const [path, hint] of [
  [webRoot, "pnpm --filter @armadra/web build"],
  [serverMain, "pnpm --filter @armadra/server build"],
]) {
  if (!existsSync(path)) {
    console.error(`先 ${hint}`);
    process.exit(2);
  }
}

/**
 * 控制台页面的 CSP 按哪一份测：缺省 `proposed`——把控制面的 CSP 换成云端要上的那一份
 * （armadra-cloud#153：原样加 `img-src` / `media-src` 的 `blob:` 与
 * Trusted Types），验证这份改动够用；`current` 不动，看控制面现在的 CSP 拦什么。
 */
const CSP_MODE = process.env.ARMADRA_SAAS_CSP ?? "proposed";
/** 要改写或追加的指令（同名的覆盖；`frame-src` 照生产不动，不放行 `blob:`）。 */
const PROPOSED_DIRECTIVES = {
  "img-src": () => "'self' blob: data:",
  "media-src": () => "'self' blob:",
  "require-trusted-types-for": () => "'script'",
  "trusted-types": () => "armadra armadra-sanitize default dompurify",
};

/** 现有 CSP → 云端要上的那一份：逐条指令改写（重复的指令浏览器只认第一条，不能只往后追加）。 */
function proposedCsp(base) {
  const directives = new Map();
  for (const part of base.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const [name, ...values] = trimmed.split(/\s+/);
    if (!directives.has(name)) directives.set(name, values.join(" "));
  }
  for (const [name, value] of Object.entries(PROPOSED_DIRECTIVES))
    directives.set(name, value(directives.get(name)));
  return [...directives]
    .map(([name, value]) => `${name} ${value}`.trim())
    .join("; ");
}

/**
 * `ARMADRA_SAAS_WEB_ROOT`：控制台页面不用部署挂的那份，而由探针按本地构建（如 `apps/web/dist`）
 * 答——不改部署的 `WEB_DIR`。`/v1`、`/.well-known` 与中继照常走部署。
 */
const WEB_ROOT = process.env.ARMADRA_SAAS_WEB_ROOT
  ? resolve(process.env.ARMADRA_SAAS_WEB_ROOT)
  : "";
/** 控制面回落 `index.html` 的页面路由（与 `go/internal/web/app.go` 的 `IsAppRoute` 同一张表）。 */
const APP_EXACT = new Set([
  "/",
  "/login",
  "/register",
  "/verify",
  "/reset",
  "/device",
]);
const APP_PREFIXES = ["/me/", "/t/", "/h/", "/j/", "/invite/", "/ops/"];
const isAppRoute = (path) =>
  APP_EXACT.has(path) ||
  APP_PREFIXES.some(
    (prefix) => path.startsWith(prefix) || path === prefix.slice(0, -1),
  );
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
/** WS 握手子协议里的令牌与票、Cookie：写进结果之前打码。 */
const redact = (text) =>
  String(text)
    .replace(/armadra-(relay|ticket)\.[^\s",;\\]+/g, "armadra-$1.<redacted>")
    .replace(/(__Host-armadra-[a-z]+)=[^\s";\\]+/g, "$1=<redacted>")
    .replace(/(Bearer\s+)[^\s",\\]+/gi, "$1<redacted>")
    // 服务器壳日志里打印的首个管理员配对链接。
    .replace(/(#pair=)[^\s"\\]+/g, "$1<redacted>")
    // 分享链接的片段（秘密与邀请令牌）。
    .replace(/(\/j\/[^\s#"\\]+)#[^\s"\\]+/g, "$1#<redacted>")
    // JSON 里的令牌字段（含日志行里转义过一层的）。
    .replace(
      /(\\?"(?:refreshToken|refresh_token|csrfToken|csrf_token|accessToken|access_token|relayToken|assertion)\\?"\s*:\s*\\?")[^"\\]+/g,
      "$1<redacted>",
    );

const report = {
  status: "failed",
  output,
  issuer: ISSUER,
  cspMode: CSP_MODE,
  violations: [],
  cspFailures: [],
  scenarios: [],
};
const cleanups = [];
// 数据目录放短路径（私有通道是 Unix socket，路径有长度上限）。
const scratch = mkdtempSync(
  join(existsSync("/tmp") ? "/tmp" : tmpdir(), "saasb2b-"),
);

/* -------------------------------- 云端 API -------------------------------- */

async function cloud(path, init = {}, token) {
  const answer = await fetch(`${ISSUER}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await answer.text();
  if (!answer.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${answer.status} ${text.slice(0, 300)}`,
    );
  return text ? JSON.parse(text) : {};
}

async function cloudLogin(account) {
  const answer = await cloud("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      account: account.email,
      password: account.password,
      device: { platform: "desktop", name: "saas-host-e2e" },
    }),
  });
  const token = answer.session?.accessToken ?? answer.accessToken;
  if (!token) throw new Error("云端登录没有给访问令牌");
  return token;
}

/* -------------------------------- 服务器壳 -------------------------------- */

async function startHost(name, dataDir, port) {
  const home = join(scratch, `${name}-home`);
  mkdirSync(home, { recursive: true });
  rmSync(join(dataDir, "endpoints.json"), { force: true });
  const child = spawn(
    process.execPath,
    [
      serverMain,
      "serve",
      "--data-dir",
      dataDir,
      "--listen",
      `127.0.0.1:${port}`,
      "--web-root",
      webRoot,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        ARMADRA_DATA_DIR: dataDir,
        ARMADRA_REAP_ON_STOP: "1",
        ARMADRA_SECRET_BACKEND: "file",
        // `node-pty` 是 `--external` 的原生模块，装在桌面包下（`apps/server/scripts/build.mjs`）。
        NODE_PATH: join(root, "apps/desktop/node_modules"),
      },
    },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log = (log + chunk).slice(-400_000)));
  child.stderr.on("data", (chunk) => (log = (log + chunk).slice(-400_000)));
  await until(
    () => existsSync(join(dataDir, "endpoints.json")) || null,
    `${name} 写出 endpoints.json`,
    { timeout: 60_000 },
  );
  // 服务器壳对外是自签 HTTPS；探针走 core 自己的回环 HTTP（endpoints.json）。
  const base = JSON.parse(readFileSync(join(dataDir, "endpoints.json"), "utf8"))
    .runtime.http;
  return {
    child,
    base,
    log: () => log,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), sleep(10_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

/** host1 数据库里的一条只读查询（`sqlite3` 命令行）。 */
function hostQuery(dataDir, sql) {
  return execFileSync(
    "sqlite3",
    ["-readonly", "-json", join(dataDir, "canvas.db"), sql],
    { encoding: "utf8" },
  ).trim();
}

const rows = (text) => (text ? JSON.parse(text) : []);

/* --------------------------------- 浏览器 --------------------------------- */

async function startChrome() {
  const profile = join(scratch, "chrome-profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--lang=zh-CN",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      ...(SPKI ? [`--ignore-certificate-errors-spki-list=${SPKI}`] : []),
      ...(CSP_MODE === "proposed" || WEB_ROOT
        ? ["--disable-features=LocalNetworkAccessChecks"]
        : []),
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  cleanups.push(() => child.kill("SIGKILL"));
  const port = await until(
    () => {
      try {
        return (
          readFileSync(join(profile, "DevToolsActivePort"), "utf8")
            .split("\n")[0]
            .trim() || null
        );
      } catch {
        return null;
      }
    },
    "Chrome 写出 DevToolsActivePort",
    { timeout: 20_000 },
  );
  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const browser = await connectBrowser(version.webSocketDebuggerUrl);
  cleanups.push(() => browser.close());
  return browser;
}

/**
 * 一个标签页：页面加载前装上 CSP 违规监听（经 binding 报回探针，刷新不丢）；控制台来源的
 * 文档响应叠一条 Trusted Types 的 CSP；记下 429。
 */
const tabs = [];
async function openTab(browser, context, label) {
  const page = await browser.page(context);
  tabs.push(page);
  page.label = label;
  page.statuses = [];
  page.failures = [];
  await page.call("Runtime.addBinding", { name: "__armadraCsp" });
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `addEventListener("securitypolicyviolation", (event) => {
      try {
        globalThis.__armadraCsp(JSON.stringify({
          directive: event.effectiveDirective,
          blocked: String(event.blockedURI).slice(0, 200),
          sample: String(event.sample ?? "").slice(0, 120),
          source: String(event.sourceFile ?? "").slice(-80) + ":" + event.lineNumber,
          page: location.pathname,
        }));
      } catch {}
    });`,
  });
  browser.on((message) => {
    if (message.sessionId !== page.sessionId) return;
    if (
      message.method === "Runtime.bindingCalled" &&
      message.params.name === "__armadraCsp"
    ) {
      const violation = { tab: label, ...JSON.parse(message.params.payload) };
      // 探针自己检查强制与否时造的那一次。
      if (String(violation.sample).includes("tt-check.invalid")) return;
      report.violations.push(violation);
      console.log(`  CSP   ${JSON.stringify(violation)}`);
    }
    // 只记状态与地址（打码），不记请求头：WS 握手的子协议里是中继令牌与票。
    if (message.method === "Network.responseReceived") {
      const { status, url } = message.params.response;
      if (status === 429) page.statuses.push({ status, url: redact(url) });
      if (status >= 400) page.failures.push(redact(`${status} ${url}`));
    }
    if (message.method === "Network.loadingFailed") {
      page.failures.push(
        `failed ${message.params.errorText} ${message.params.type}`,
      );
    }
    if (message.method === "Network.webSocketCreated") {
      page.failures.push(redact(`ws ${message.params.url.slice(0, 120)}`));
    }
    if (message.method === "Network.webSocketHandshakeResponseReceived") {
      page.failures.push(`ws handshake ${message.params.response.status}`);
    }
    if (message.method === "Network.webSocketFrameError") {
      page.failures.push(redact(`ws error ${message.params.errorMessage}`));
    }
    if (message.method === "Network.webSocketClosed") {
      page.failures.push(`ws closed ${message.params.requestId}`);
    }
    if (message.method === "Fetch.requestPaused")
      void intercept(page, message.params);
  });
  await page.call("Network.enable", {});
  if (WEB_ROOT)
    await page.call("Fetch.enable", {
      patterns: [{ urlPattern: `${ISSUER}/*`, requestStage: "Request" }],
    });
  else if (CSP_MODE === "proposed")
    await page.call("Fetch.enable", {
      patterns: [
        {
          urlPattern: `${ISSUER}/*`,
          resourceType: "Document",
          requestStage: "Response",
        },
      ],
    });
  // 控制台错误里预期内的几条：主机下线、登出、撤销时的请求失败。
  page.allowed.push(
    /Failed to load resource/,
    /WebSocket connection to/,
    /net::ERR_/,
    /status of 40[13]/,
    /status of 50[23]/,
  );
  return page;
}

/** 控制面现在给控制台页面的 CSP（本地答页面时照它，再按档位追加）。 */
let consoleCsp = "";

/** 页面文档最终的 CSP：`proposed` 追加 `blob:` 与 Trusted Types，`current` 原样。 */
const documentCsp = (base) =>
  CSP_MODE === "proposed" ? proposedCsp(base) : base;

/**
 * 控制台文档换上要测的 CSP；给了 `ARMADRA_SAAS_WEB_ROOT` 时页面与资源也由本地构建答。换掉（而不是
 * 叠加）响应头要整份重造响应——`continueResponse` 去不掉已解析的原 CSP；重造的响应没有对端地址，
 * 本地网络访问检查会把页面当公网来源，所以这时的 Chrome 关掉了那项检查（只用于本地部署上的模拟）。
 * 换不上记一条失败，探针最后据此判失败。
 */
async function intercept(page, params) {
  try {
    const url = new URL(params.request.url);
    if (WEB_ROOT && params.responseStatusCode === undefined) {
      const local = isAppRoute(url.pathname)
        ? join(WEB_ROOT, "index.html")
        : join(WEB_ROOT, url.pathname);
      const servable =
        !url.pathname.startsWith("/v1/") &&
        !url.pathname.startsWith("/.well-known/") &&
        local.startsWith(WEB_ROOT) &&
        existsSync(local) &&
        statSync(local).isFile();
      if (!servable) {
        await page.call("Fetch.continueRequest", {
          requestId: params.requestId,
        });
        return;
      }
      const html = local.endsWith(".html");
      const headers = [
        {
          name: "Content-Type",
          value: CONTENT_TYPES[extname(local)] ?? "application/octet-stream",
        },
        { name: "Cache-Control", value: "no-store" },
        ...(html
          ? [
              {
                name: "Content-Security-Policy",
                value: documentCsp(consoleCsp),
              },
            ]
          : []),
      ];
      if (html) report.csp = documentCsp(consoleCsp);
      await page.call("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: headers,
        body: readFileSync(local).toString("base64"),
      });
      return;
    }
    if (params.responseStatusCode === undefined) {
      await page.call("Fetch.continueRequest", { requestId: params.requestId });
      return;
    }
    const headers = params.responseHeaders ?? [];
    const isCsp = (header) =>
      header.name.toLowerCase() === "content-security-policy";
    const responseHeaders = [
      ...headers.filter((header) => !isCsp(header)),
      ...headers.filter(isCsp).map((header) => ({
        name: header.name,
        value: documentCsp(header.value),
      })),
    ];
    report.csp = responseHeaders.find(isCsp)?.value;
    const body = await page.call("Fetch.getResponseBody", {
      requestId: params.requestId,
    });
    await page.call("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: params.responseStatusCode,
      responseHeaders,
      body: body.base64Encoded
        ? body.body
        : Buffer.from(body.body).toString("base64"),
    });
  } catch (error) {
    report.cspFailures.push(String(error?.message ?? error));
    console.log(`  FAIL  换 CSP / 本地页面失败：${error.message}`);
    await page
      .call("Fetch.continueRequest", { requestId: params.requestId })
      .catch(() => undefined);
  }
}

/**
 * 页面上 Trusted Types 真的在强制：往 `script.src` 写一个不在白名单里的地址，`default` 策略
 * 拒绝就抛（不强制时赋值照常成功）。这一次自己造的违规不计入。
 */
const TT_PROBE_URL = "https://tt-check.invalid/probe.js";
async function trustedTypesEnforced(page) {
  return page.evaluate(`try {
    document.createElement("script").src = ${JSON.stringify(TT_PROBE_URL)};
    return false;
  } catch {
    return true;
  }`);
}

/** 页面里用 Cookie 会话登录控制台（同源 `auth.login`，设 `__Host-armadra-cloud`）。 */
async function consoleSignIn(page, account) {
  await page.goto(`${ISSUER}/login`);
  const answer = await page.evaluate(`
    const answer = await fetch("/v1/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(${JSON.stringify({
        account: account.email,
        password: account.password,
        device: { platform: "browser", name: "saas-host-e2e" },
      })}),
    });
    const body = await answer.json().catch(() => ({}));
    return { status: answer.status, csrf: body.csrfToken ?? body.session?.csrfToken ?? "" };`);
  if (answer.status !== 200) throw new Error(`控制台登录：${answer.status}`);
  return answer.csrf;
}

/** 页面里（Cookie 会话、带 CSRF）批准一个设备码：批准只认 Cookie 会话或提权的 Bearer。 */
async function approveDeviceCode(page, csrf, userCode) {
  const status = await page.evaluate(`
    const answer = await fetch("/v1/auth/device/approve", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-armadra-csrf": ${JSON.stringify(csrf)} },
      body: JSON.stringify({ userCode: ${JSON.stringify(userCode)}, approve: true }),
    });
    return answer.status;`);
  if (status >= 300) throw new Error(`批准设备码：${status}`);
}

const hostReady = (terminalId) =>
  `return !!document.querySelector('[data-slot="host-bar"]') && !!document.querySelector('${nodeAt(terminalId)} .xterm');`;

const pageText = (page) => page.evaluate("return document.body.innerText;");

/* --------------------------------- 主流程 --------------------------------- */

let host;
const hostDir = join(scratch, "host1");
mkdirSync(hostDir, { recursive: true, mode: 0o700 });

try {
  consoleCsp =
    (await fetch(`${ISSUER}/login`)).headers.get("content-security-policy") ??
    "";
  const ownerToken = await cloudLogin(accounts.owner);
  const memberToken = await cloudLogin(accounts.member);
  const spaces = await cloud("/v1/me/spaces", {}, ownerToken);
  const team = spaces.spaces.find(
    (space) => space.kind === "team" && space.slug === TEAM,
  );
  if (!team) throw new Error(`owner 不在团队 ${TEAM}`);
  const member = await cloud("/v1/me", {}, memberToken);

  /* ---------- host1：设备码登录 owner、登记到团队（登记即映射主人） ---------- */
  const hostPort = await freePort();
  host = await startHost("host1", hostDir, hostPort);
  cleanups.push(() => host?.stop());
  let session = await probeSession({ dataDir: hostDir, base: host.base });
  const local = async (path, init = {}) => {
    const answer = await session.fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(`${path} → ${answer.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  const added = await local("/api/sources/remotes", {
    method: "POST",
    body: JSON.stringify({ kind: "saas", issuer: ISSUER, label: "saas" }),
  });
  const serviceId = added.remote.serviceId;
  const browser = await startChrome();
  const ownerContext = await browser.context();
  const memberContext = await browser.context();
  const ownerTab = await openTab(browser, ownerContext, "owner");
  const ownerCsrf = await consoleSignIn(ownerTab, accounts.owner);
  await approveDeviceCode(ownerTab, ownerCsrf, added.next.deviceCode.userCode);
  await until(
    async () =>
      (
        await local(`/api/sources/remotes/${serviceId}/poll`, {
          method: "POST",
          body: "{}",
        })
      ).status === "ready" || null,
    "host1 设备码登录就绪",
    { timeout: 60_000, every: 1_000 },
  );
  const registered = await local(`/api/sources/remotes/${serviceId}/register`, {
    method: "POST",
    body: JSON.stringify({
      space: { kind: "team", teamId: team.teamId },
      label: `host1-b2b-${Date.now() % 100_000}`,
    }),
  });
  const hostId = registered.sourceId;
  report.hostId = hostId;
  // 跑完撤销这台（空间的主机数有上限，不留下一台台离线的测试主机）。
  cleanups.push(() =>
    cloud(`/v1/sources/${hostId}`, { method: "DELETE" }, ownerToken),
  );
  await until(
    async () =>
      (await cloud(`/v1/sources/${hostId}`, {}, ownerToken)).online || null,
    "host1 在控制台在线",
    { timeout: 60_000, every: 1_000 },
  );
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  // 主机内容：一张图（经通道取成 blob:），一份冒充 PDF 的网页、一份带注入 HTML 的 Markdown。
  writeFileSync(
    join(project, "logo.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  writeFileSync(
    join(project, "manual.pdf"),
    // 一份真的 PDF：控制台来源上只给下载，不进框架（生产 CSP 的 `frame-src` 不放行 `blob:`）。
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
  writeFileSync(
    join(project, "evil.pdf"),
    "<script>top.pwned = 'pdf'</script><h1>not a pdf</h1>",
  );
  writeFileSync(
    join(project, "notes.md"),
    "# notes\n\n<img src=x onerror=\"top.pwned='md'\">\n\n<script>top.pwned='md2'</script>\n",
  );
  const workspace = await local("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "b2b",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await local(`/api/workspaces/${workspace.id}/boards`);
  const board =
    boards[0] ??
    (await local(`/api/workspaces/${workspace.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "b2b" }),
    }));
  const terminal = makeNode(
    board.id,
    "terminal",
    "shell",
    { x: 80, y: 80 },
    { width: 560, height: 320 },
    { kind: "terminal", cwd: project },
  );
  const fileNode = (title, path, y) =>
    makeNode(
      board.id,
      "editor",
      title,
      { x: 680, y },
      { width: 360, height: 220 },
      { kind: "editor", path },
    );
  const files = {
    image: fileNode("logo.png", "logo.png", 40),
    pdf: fileNode("evil.pdf", "evil.pdf", 290),
    manual: fileNode("manual.pdf", "manual.pdf", 790),
    markdown: fileNode("notes.md", "notes.md", 540),
  };
  const document = await local(
    `/api/workspaces/${workspace.id}/boards/${board.id}/document`,
  );
  await local(`/api/workspaces/${workspace.id}/boards/${board.id}/document`, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: document.board.updatedAt,
      nodes: [terminal, ...Object.values(files)],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    }),
  });
  const hostUrl = `${ISSUER}/h/${hostId}?ws=${encodeURIComponent(workspace.id)}`;
  const approve = (page, what) =>
    untilApproved(page, session, hostReady(terminal.id), what, {
      timeout: 90_000,
    });

  /* ----------------------- E7 前半：member 待确认、信任页 ----------------------- */
  let memberTab;
  let grantId;
  /** member 对 host1 的 driver 授予（先清掉旧的）。 */
  const grantMember = async () => {
    const existing = await cloud(
      `/v1/grants?sourceId=${hostId}`,
      {},
      ownerToken,
    );
    for (const grant of existing.grants)
      if (
        grant.subject.kind === "member" &&
        grant.subject.accountId === member.accountId
      )
        await cloud(
          `/v1/grants/${grant.grantId}`,
          { method: "DELETE" },
          ownerToken,
        );
    const created = await cloud(
      "/v1/grants",
      {
        method: "POST",
        body: JSON.stringify({
          sourceId: hostId,
          subject: { kind: "member", accountId: member.accountId },
          role: "driver",
        }),
      },
      ownerToken,
    );
    grantId = created.grantId;
  };
  /** 信任页上某人的那一行（按成员名找）；找不到答 null。 */
  const trustRow = (name) =>
    `[...document.querySelectorAll('table tr')].find((row) => row.innerText.includes(${JSON.stringify(name)}))`;
  let e7;
  if (ONLY.has("E7")) {
    const s = scenario(
      report,
      "E7a 信任页：不是受信设备的行给「在此浏览器打开主机」",
      output,
    );
    await grantMember();
    memberTab = await openTab(browser, memberContext, "member");
    await consoleSignIn(memberTab, accounts.member);
    await memberTab.goto(hostUrl);
    const memberSas = await memberTab.until(
      SAS_ON_PAGE,
      "member 停在待确认、显示校验码",
      {
        timeout: 60_000,
      },
    );
    s.ok("member 的新浏览器停在待确认");
    const trustTab = await openTab(browser, ownerContext, "owner-trust");
    await trustTab.goto(`${ISSUER}/t/${TEAM}/trust`);
    const href = await trustTab.until(
      `const row = ${trustRow(accounts.member.name)};
       const link = row && [...row.querySelectorAll('a')].find((a) => a.innerText.includes("在此浏览器打开主机"));
       return link ? link.getAttribute("href") : null;`,
      "member 那一行给「在此浏览器打开主机」",
      { timeout: 60_000 },
    );
    s.check(href === `/h/${hostId}`, "链接指向这台主机的 /h/", href);
    s.check(
      !(await trustTab.evaluate(
        `const row = ${trustRow(accounts.member.name)}; return [...row.querySelectorAll('button')].some((b) => b.innerText.trim() === "信任");`,
      )),
      "还不是受信设备：没有「信任」",
    );
    await s.shot(trustTab, "e7a-trust-open-host");
    s.entry.status = "passed";
    e7 = { memberSas, trustTab };
  }

  /* ------------------------------------ E2 ------------------------------------ */
  // owner 先进 host1：E3–E7 都靠它；只跑 E8 时（访客不用 owner 进来）才跳过。
  if ([...ONLY].some((step) => step !== "E8")) {
    const s = scenario(
      report,
      "E2 owner 打开 /h/：待确认 → 放行 → 画布与终端",
      output,
    );
    await ownerTab.goto(hostUrl);
    if (CSP_MODE === "proposed") {
      s.check(
        /require-trusted-types-for 'script'/.test(report.csp ?? ""),
        "生效的 CSP 里有 require-trusted-types-for",
        report.csp ?? "",
      );
      s.check(
        await trustedTypesEnforced(ownerTab),
        "页面上 Trusted Types 真的在强制",
      );
    }
    const approvals = await approve(ownerTab, "owner 进入 host1");
    s.check(approvals === 1, "新浏览器先待确认，主机放行一次", approvals);
    // #606：登记名是浏览器与系统（`browserDevice()`），不是原生 App 的「Armadra iOS」。
    const ownerDevices = rows(
      hostQuery(
        hostDir,
        "select d.label, d.platform from trusted_devices d join identity_principals p on p.principal_id = d.principal_id where p.kind = 'owner' and d.status = 'trusted'",
      ),
    );
    s.check(
      ownerDevices.length === 1 &&
        ownerDevices[0].platform === "browser" &&
        /^Armadra Web \([A-Za-z]+, [A-Za-z]+\)$/.test(ownerDevices[0].label),
      "host1 上 owner 的浏览器按浏览器与系统登记",
      ownerDevices,
    );
    await terminalRoundTrip(ownerTab, terminal.id, "saas");
    s.ok("终端收发 42saas");
    const text = await pageText(ownerTab);
    s.check(
      !text.includes("把你当作成员"),
      "身份面会话是本机 owner（没有主人映射提示）",
    );
    s.check(
      !(await ownerTab.evaluate("return location.search.includes('ws=');")),
      "?ws= 进去后从地址栏抹掉",
    );
    await ownerTab.until(
      `const image = document.querySelector('${nodeAt(files.image.id)} img');
       return image && image.src.startsWith("blob:") && image.complete && image.naturalWidth > 0 ? true : null;`,
      "图片预览经通道取成 blob: 显示",
      { timeout: 30_000 },
    );
    s.ok("主机上的图片按 blob: 预览");
    await ownerTab.until(
      `return document.querySelector('${nodeAt(files.markdown.id)}')?.innerText.includes("notes") ? true : null;`,
      "Markdown 文件打开",
      { timeout: 30_000 },
    );
    await sleep(2_000);
    s.check(
      !(await ownerTab.evaluate(
        `return !!document.querySelector('${nodeAt(files.pdf.id)} iframe');`,
      )),
      "冒充 PDF 的网页不进框架（控制台来源上 PDF 只给下载）",
    );
    await ownerTab.until(
      `const node = document.querySelector('${nodeAt(files.manual.id)}');
       return node && !node.querySelector('iframe') && node.innerText.includes("manual.pdf") ? true : null;`,
      "真的 PDF 打开成下载卡片",
      { timeout: 30_000 },
    );
    s.ok("真的 PDF 在控制台来源上只给下载、不进框架");
    s.check(
      (await ownerTab.evaluate("return globalThis.pwned ?? null;")) === null,
      "注入的主机文件内容没有执行",
    );
    await s.shot(ownerTab, "e2-owner-host");
    s.entry.status = "passed";
  }

  /* ----------------------- E7 后半：背书、通知与 Q14 ----------------------- */
  if (e7 !== undefined) {
    const s = scenario(
      report,
      "E7b 控制台背书 member、背书通知、Q14 forbidden",
      output,
    );
    const { trustTab, memberSas } = e7;
    await trustTab.until(
      `const row = ${trustRow(accounts.member.name)};
       return row && [...row.querySelectorAll('button')].some((b) => b.innerText.trim() === "信任") &&
         ![...row.querySelectorAll('a')].some((a) => a.innerText.includes("在此浏览器打开主机")) ? true : null;`,
      "/h/ 进了主机后信任页这一行改给「信任」",
      { timeout: 30_000 },
    );
    s.ok("/h/ 进了主机后，信任页不刷新就改给「信任」（受信广播）");
    /** 在信任页的一行上点「信任」、输入校验码、提交。 */
    const endorse = async (name, sas) => {
      await trustTab.clickOn(
        `const row = ${trustRow(name)}; return row && [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === "信任");`,
        `${name} 那一行的「信任」`,
      );
      await trustTab.clickOn(
        `return document.querySelector('[role="dialog"] input');`,
        "校验码输入框",
      );
      await trustTab.type(sas);
      await trustTab.clickOn(
        `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText.trim() === "信任" && !b.disabled);`,
        "对话框里的「信任」",
      );
    };
    await endorse(accounts.member.name, memberSas);
    await memberTab.until(hostReady(terminal.id), "member 被背书后自动进入", {
      timeout: 60_000,
    });
    await terminalRoundTrip(memberTab, terminal.id, "endorsed");
    s.ok("输入 member 屏幕上的码 → member 自动进入，终端可用");
    const endorsedRows = rows(
      hostQuery(
        hostDir,
        "select platform, approved_by from trusted_devices where approved_by like 'endorse:%'",
      ),
    );
    s.check(
      endorsedRows.length === 1 && endorsedRows[0].platform === "browser",
      "host1 上 member 的浏览器记成 endorse:<owner 浏览器>",
      endorsedRows,
    );
    await ownerTab.until(
      `return [...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes("放行了") && d.innerText.includes(${JSON.stringify(accounts.member.name)})) ? true : null;`,
      "owner 的 /h/ 弹出背书通知",
      { timeout: 30_000 },
    );
    s.ok("owner 的 /h/（主机页面）弹出「… 放行了 Member 的 …」");
    // #606：通知里两头都是浏览器名，没有原生 App 的「Armadra iOS」。
    const notice = await ownerTab.evaluate(
      `return [...document.querySelectorAll('[role="dialog"]')].map((d) => d.innerText).find((t) => t.includes("放行了")) ?? "";`,
    );
    s.check(
      !notice.includes("Armadra iOS") &&
        (notice.match(/Armadra Web \(/g) ?? []).length >= 2,
      "背书通知里放行者与新设备都是浏览器名",
      notice,
    );
    await s.shot(ownerTab, "e7b-endorsed-notice");
    await ownerTab.clickOn(
      `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText.trim() === "知道了");`,
      "知道了",
    );
    s.check(
      /device endorsed/.test(host.log()),
      "host1 日志记了 device endorsed",
    );

    // Q14：owner 另一个浏览器停在待确认，owner 的受信浏览器批它答 forbidden。
    const owner2Context = await browser.context();
    const owner2Tab = await openTab(browser, owner2Context, "owner2");
    await consoleSignIn(owner2Tab, accounts.owner);
    await owner2Tab.goto(hostUrl);
    const ownerSas = await owner2Tab.until(
      SAS_ON_PAGE,
      "owner 的第二个浏览器停在待确认",
      { timeout: 60_000 },
    );
    const ownerPending = () =>
      rows(
        hostQuery(
          hostDir,
          "select d.status from trusted_devices d join identity_principals p on p.principal_id = d.principal_id where p.kind = 'owner' and d.status = 'pending'",
        ),
      ).length;
    s.check(
      ownerPending() === 1,
      "host1 上有一条 owner 的待确认",
      ownerPending(),
    );
    // 主机页面（owner 的 /h/）的放行提示带上设备自报的平台：防线靠放行的人核对平台。
    const promptText = await ownerTab.until(
      `const dialog = [...document.querySelectorAll('[role="dialog"]')].find((one) => one.innerText.includes("请求访问"));
       return dialog ? dialog.innerText : null;`,
      "owner 的 /h/ 弹出放行提示",
      { timeout: 30_000 },
    );
    s.check(
      promptText.includes("浏览器") &&
        !promptText.includes("放行后，它能批准主人的新设备"),
      "放行提示显示平台「浏览器」，没有原生端的那句提示",
      promptText.replace(/\s+/g, " ").slice(0, 120),
    );
    await s.shot(ownerTab, "e7b-approval-platform");
    await ownerTab.key("Escape");
    await ownerTab.until(
      `return [...document.querySelectorAll('[role="dialog"]')].some((one) => one.innerText.includes("请求访问")) ? null : true;`,
      "放行提示关掉",
      { timeout: 10_000 },
    );
    await trustTab.reload();
    const listed = await trustTab
      .until(
        `const row = ${trustRow(accounts.owner.name)}; return row && [...row.querySelectorAll('button')].some((b) => b.innerText.trim() === "信任") ? true : null;`,
        "信任页列出 owner 自己的新浏览器",
        { timeout: 30_000 },
      )
      .then(
        () => true,
        () => false,
      );
    // 信任页批不成时有两种答法：主机答 forbidden（对话框改口），或信任页在主机上对不上这条申请
    // （不放行，提示「还没有这台设备的申请」）。后一种改经 /h/ 的设备页批，那里要答 forbidden。
    let viaTrustPage = false;
    if (listed) {
      await endorse(accounts.owner.name, ownerSas);
      const outcome = await trustTab.until(
        `if (document.querySelector('[role="dialog"]')?.innerText.includes("在已信任的设备上处理")) return "forbidden";
         return document.body.innerText.includes("这台主机上还没有这台设备的申请") ? "unmatched" : null;`,
        "信任页批 owner 自己的新浏览器没有放行",
        { timeout: 30_000 },
      );
      if (outcome === "forbidden") {
        viaTrustPage = true;
        s.ok("owner 的受信浏览器经信任页批 owner 自己的新浏览器：forbidden");
        await s.shot(trustTab, "e7b-owner-forbidden");
      } else {
        s.ok(
          "信任页在主机上对不上 owner 自己的这条申请、不放行，改经 /h/ 的设备页批",
        );
      }
      await trustTab.key("Escape");
    } else {
      s.ok(
        "信任页没有列出 owner 自己的新浏览器（云端不列），改经 /h/ 的设备页批",
      );
    }
    // 经 owner 的 /h/（浏览器端到端通道）打开设置 → 设备与会话：批 owner 的待确认、配对新设备。
    // 通知框关闭的动画结束前点不到侧栏：点到设置框出来为止。
    await until(
      async () => {
        if (
          await ownerTab.evaluate(
            `return !!document.querySelector('[role="dialog"] nav');`,
          )
        )
          return true;
        await ownerTab.clickOn(
          `return [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "设置" || b.getAttribute("aria-label") === "设置")`,
          "设置按钮",
        );
        await sleep(800);
        return null;
      },
      "设置框",
      { timeout: 20_000, every: 200 },
    );
    await ownerTab.clickOn(
      `return [...document.querySelectorAll('[role="dialog"] nav button')].find((b) => b.getAttribute("aria-label") === "设备与会话" || b.innerText.trim() === "设备与会话")`,
      "设置导航「设备与会话」",
    );
    if (!viaTrustPage) {
      await ownerTab.until(
        `return [...document.querySelectorAll('[role="dialog"] tr')].some((row) => row.innerText.includes("待确认")) ? true : null;`,
        "设备页列出待确认",
        { timeout: 30_000 },
      );
      await ownerTab.clickOn(
        `return document.querySelector('[role="dialog"] tr input[inputmode="numeric"]');`,
        "待确认那行的校验码输入框",
      );
      await ownerTab.type(ownerSas);
      await ownerTab.clickOn(
        `return [...document.querySelectorAll('[role="dialog"] tr button')].find((b) => b.innerText.trim() === "允许" && !b.disabled);`,
        "「允许」",
      );
      await ownerTab.until(
        `return /没有权限执行这个操作|主人的新设备不能在浏览器里放行/.test(document.body.innerText) ? true : null;`,
        "设备页提示 forbidden",
        { timeout: 30_000 },
      );
      s.ok("owner 的受信浏览器经设备页批 owner 自己的新浏览器：forbidden");
    }
    await sleep(1_000);
    s.check(ownerPending() === 1, "owner 的新浏览器仍待确认", ownerPending());
    // 上一步的提示可能还在：按出现次数认这一步新弹出的那条。
    const refusals =
      "(document.body.innerText.match(/没有权限执行这个操作|不能在浏览器里/g) ?? []).length";
    const before = await ownerTab.evaluate(`return ${refusals};`);
    await ownerTab.clickOn(
      `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText.trim() === "配对新设备")`,
      "「配对新设备」",
    );
    await ownerTab.until(
      `return ${refusals} > ${before} ? true : null;`,
      "配对新设备答 forbidden",
      { timeout: 30_000 },
    );
    s.check(
      !(await ownerTab.evaluate(
        `return document.body.innerText.includes("用新设备扫码");`,
      )),
      "没有出二维码",
    );
    s.ok("经 owner 的受信浏览器调 e2e.pairingSecret：forbidden");
    await s.shot(ownerTab, "e7b-pairing-forbidden");
    await ownerTab.key("Escape");
    await owner2Tab.close();
    s.entry.status = "passed";

    // E7c（#607，契约 §81.1）：背书进需要人处理，见 saas-host-e2e-notices.mjs。
    await endorsementNotices({
      report,
      output,
      issuer: ISSUER,
      team: TEAM,
      accounts,
      browser,
      openTab,
      consoleSignIn,
      endorse,
      hostUrl,
      trustTab,
      trustRow,
      ready: hostReady(terminal.id),
      ownerTab,
      memberTab,
      hostRows: (sql) => rows(hostQuery(hostDir, sql)),
    });
  }

  /* ------------------------------------ E3 ------------------------------------ */
  if (ONLY.has("E3")) {
    const s = scenario(report, "E3 刷新三次与复制标签页", output);
    const sessionsBefore = rows(
      hostQuery(hostDir, "select count(*) as n from identity_sessions"),
    )[0].n;
    for (let round = 1; round <= 3; round += 1) {
      await ownerTab.reload();
      await ownerTab.until(
        hostReady(terminal.id),
        `第 ${round} 次刷新后进画布`,
        {
          timeout: 60_000,
        },
      );
      const sas = await ownerTab.evaluate(
        "return !!document.querySelector('[role=\"dialog\"]');",
      );
      s.check(!sas, `第 ${round} 次刷新不再待确认`);
    }
    const sessionsAfter = rows(
      hostQuery(hostDir, "select count(*) as n from identity_sessions"),
    )[0].n;
    s.check(
      sessionsAfter === sessionsBefore,
      "主机侧会话不新增",
      `${sessionsBefore} → ${sessionsAfter}`,
    );
    // 复制标签页：浏览器连同 sessionStorage 一起复制。
    const stored = await ownerTab.evaluate(
      "return JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)));",
    );
    const copy = await openTab(browser, ownerContext, "owner-copy");
    await copy.goto(`${ISSUER}/login`);
    await copy.evaluate(
      `for (const [k, v] of Object.entries(${stored})) sessionStorage.setItem(k, v); return true;`,
    );
    await copy.goto(hostUrl.replace(/\?ws=.*$/, ""));
    await copy
      .until(hostReady(terminal.id), "复制出的标签页进画布", {
        timeout: 60_000,
      })
      .catch(async () => {
        // 没带 ?ws= 时停在主机的首页：打开同一个工作空间。
        await copy.goto(hostUrl);
        await copy.until(hostReady(terminal.id), "复制出的标签页进画布", {
          timeout: 60_000,
        });
      });
    await terminalRoundTrip(copy, terminal.id, "copy");
    await terminalRoundTrip(ownerTab, terminal.id, "orig");
    s.ok("两个标签页的终端都能用");
    const added =
      rows(hostQuery(hostDir, "select count(*) as n from identity_sessions"))[0]
        .n - sessionsAfter;
    s.check(added <= 1, "复制标签页最多重登一次", added);
    const limited = [...ownerTab.statuses, ...copy.statuses];
    s.check(limited.length === 0, "没有 429", limited);
    await copy.close();
    s.entry.status = "passed";
  }

  /* ------------------------------------ E4 ------------------------------------ */
  if (ONLY.has("E4")) {
    const s = scenario(report, "E4 主机停了再起、中继节点重建", output);
    await host.stop();
    await ownerTab
      .until(
        "return document.body.innerText.includes('不在线') || document.body.innerText.includes('离线') || document.body.innerText.includes('等待') ? true : null;",
        "页面显示主机不在线",
        { timeout: 60_000 },
      )
      .then(
        () => s.ok("停 host1：页面显示不在线"),
        () => s.ok("停 host1：没有找到不在线文案（只看能否恢复）"),
      );
    await s.shot(ownerTab, "e4-offline");
    host = await startHost("host1", hostDir, hostPort);
    session = await probeSession({ dataDir: hostDir, base: host.base });
    await ownerTab.until(hostReady(terminal.id), "host1 回来后回到画布", {
      timeout: 90_000,
    });
    await terminalRoundTrip(ownerTab, terminal.id, "back");
    s.ok("host1 回来后终端照常");
    if (COMPOSE) {
      for (const node of ["relay-a", "relay-b"]) {
        execFileSync(
          COMPOSE,
          ["up", "-d", "--force-recreate", "--no-deps", node],
          { stdio: "ignore" },
        );
        await sleep(3_000);
      }
      await until(
        async () =>
          (await cloud(`/v1/sources/${hostId}`, {}, ownerToken)).online || null,
        "节点重建后 host1 在线",
        { timeout: 90_000, every: 1_000 },
      );
      await terminalRoundTrip(ownerTab, terminal.id, "node");
      s.ok("中继节点重建后终端照常");
    }
    s.entry.status = "passed";
  }

  /* ------------------------------------ E8 ------------------------------------ */
  if (ONLY.has("E8"))
    await runGuestLink({
      report,
      output,
      ISSUER,
      accounts,
      browser,
      openTab,
      consoleSignIn,
      local,
      serviceId,
      workspace,
      hostId,
      terminal,
    });

  /* ----------------------------------- E10 ----------------------------------- */
  if (ONLY.has("E10"))
    await runNewLink({
      report,
      output,
      ISSUER,
      TEAM,
      accounts,
      browser,
      ownerContext,
      openTab,
      consoleSignIn,
      local,
      serviceId,
      hostId,
      hostQuery: (sql) => hostQuery(hostDir, sql),
    });

  /* ------------------------------------ E5 ------------------------------------ */
  memberTab ??= await openTab(browser, memberContext, "member");
  if (ONLY.has("E5")) {
    const s = scenario(report, "E5 授予收窄：去抖重登、终端变只读", output);
    const existing = await cloud(
      `/v1/grants?sourceId=${hostId}`,
      {},
      ownerToken,
    );
    for (const grant of existing.grants)
      if (
        grant.subject.kind === "member" &&
        grant.subject.accountId === member.accountId
      )
        await cloud(
          `/v1/grants/${grant.grantId}`,
          { method: "DELETE" },
          ownerToken,
        );
    const created = await cloud(
      "/v1/grants",
      {
        method: "POST",
        body: JSON.stringify({
          sourceId: hostId,
          subject: { kind: "member", accountId: member.accountId },
          role: "driver",
        }),
      },
      ownerToken,
    );
    grantId = created.grantId;
    await consoleSignIn(memberTab, accounts.member);
    await memberTab.goto(hostUrl);
    await approve(memberTab, "member 进入 host1");
    await terminalRoundTrip(memberTab, terminal.id, "drive");
    s.ok("member（driver）能驾驶终端");
    const loginsBefore = rows(
      hostQuery(
        hostDir,
        "select count(*) as n from audit_log where action = 'cloud.login'",
      ),
    )[0]?.n;
    const changedAt = Date.now();
    for (const role of ["viewer", "editor", "viewer"]) {
      await cloud(
        `/v1/grants/${grantId}`,
        { method: "PATCH", body: JSON.stringify({ role }) },
        ownerToken,
      );
      await sleep(400);
    }
    // 等授予同步：终端写入不再回显。
    await sleep(20_000);
    await memberTab.clickOn(
      `return document.querySelector('${nodeAt(terminal.id)} .xterm-screen')`,
      "终端画面",
    );
    await memberTab.type("echo $((40+3))ro");
    await memberTab.key("Enter");
    await sleep(3_000);
    const rowsText = await memberTab.evaluate(
      `return document.querySelector('${nodeAt(terminal.id)} .xterm-rows')?.innerText ?? "";`,
    );
    s.check(!rowsText.includes("43ro"), "收窄为只读后 member 的终端不能写");
    s.check((await pageText(memberTab)).includes("只读"), "画布标出只读");
    s.ok("同步用时", `${Math.round((Date.now() - changedAt) / 1000)} 秒内`);
    const loginsAfter = rows(
      hostQuery(
        hostDir,
        "select count(*) as n from audit_log where action = 'cloud.login'",
      ),
    )[0]?.n;
    s.check(
      typeof loginsBefore === "number" && typeof loginsAfter === "number",
      "读到 host1 的 cloud.login 审计计数",
      { loginsBefore, loginsAfter },
    );
    s.check(
      loginsAfter - loginsBefore <= 2,
      "连改三次授予，member 的重登不超过 2 次",
      loginsAfter - loginsBefore,
    );
    await s.shot(memberTab, "e5-member-readonly");
    s.entry.status = "passed";
  }

  /* ------------------------------------ E6 ------------------------------------ */
  if (ONLY.has("E6")) {
    const s = scenario(report, "E6 撤销授予与控制台登出", output);
    if (grantId !== undefined) {
      await cloud(`/v1/grants/${grantId}`, { method: "DELETE" }, ownerToken);
      await memberTab.until(
        "return document.body.innerText.includes('没有这台主机的访问权限') ? true : null;",
        "member 的 /h/ 盖上「没有权限」",
        { timeout: 30_000 },
      );
      s.ok("撤销后 member 看到「你没有这台主机的访问权限」");
      await s.shot(memberTab, "e6-member-denied");
    }
    const ownerSessions = () =>
      rows(
        hostQuery(
          hostDir,
          "select count(*) as n from identity_sessions s join identity_devices d on d.device_id = s.device_id join identity_principals p on p.principal_id = d.principal_id where s.revoked_at_ms = 0 and p.kind = 'owner' and s.origin like 'https://%'",
        ),
      )[0]?.n;
    const liveBefore = ownerSessions();
    const consoleTab = await openTab(browser, ownerContext, "owner-console");
    await consoleTab.goto(`${ISSUER}/me`);
    await consoleTab.until(
      'return document.querySelector(\'[data-slot="user-menu"], button[aria-haspopup="menu"]\') ? true : null;',
      "控制台加载",
      { timeout: 30_000 },
    );
    await consoleTab.evaluate(`
      const trigger = document.querySelector('[data-slot="user-menu"] button, [data-slot="user-menu"]') ??
        [...document.querySelectorAll('button[aria-haspopup="menu"]')].at(-1);
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      return true;`);
    await consoleTab.until(
      "const item = [...document.querySelectorAll('[role=\"menuitem\"]')].find((one) => /登出|退出/.test(one.innerText)); if (!item) return null; item.click(); return true;",
      "点「登出」",
      { timeout: 10_000 },
    );
    await ownerTab.until(
      "return document.body.innerText.includes('已登出') ? true : null;",
      "owner 的 /h/ 显示已登出",
      { timeout: 30_000 },
    );
    s.ok("控制台登出后 /h/ 显示已登出");
    await sleep(1_000);
    const liveAfter = ownerSessions();
    report.ownerSessionRows = rows(
      hostQuery(
        hostDir,
        "select s.session_id, s.origin, s.revoked_at_ms, s.created_at_ms, s.rotation from identity_sessions s join identity_devices d on d.device_id = s.device_id join identity_principals p on p.principal_id = d.principal_id where p.kind = 'owner'",
      ),
    );
    report.hostLogLogout = host
      .log()
      .split("\n")
      .filter((line) => /logout|登出|session/i.test(line))
      .slice(-20);
    s.check(
      typeof liveBefore === "number" && typeof liveAfter === "number",
      "读到 host1 上 owner 的会话计数",
      { liveBefore, liveAfter },
    );
    s.check(
      liveAfter < liveBefore,
      "host1 上 owner 的会话已吊销",
      `${liveBefore} → ${liveAfter}`,
    );
    s.check(
      (await ownerTab.evaluate(
        "return Object.keys(sessionStorage).filter((k) => k.startsWith('armadra.host.')).length;",
      )) === 0,
      "/h/ 标签页的 armadra.host.* 已清",
    );
    await s.shot(ownerTab, "e6-owner-signed-out");
    s.entry.status = "passed";
  }

  report.status =
    report.cspFailures.length > 0
      ? "failed (CSP not applied)"
      : report.violations.length === 0
        ? "passed"
        : "failed (CSP violations)";
} catch (error) {
  report.error = String(error?.stack ?? error);
  for (const page of tabs) {
    try {
      await page.capture(join(output, `failed-${page.label}.png`));
      report[`text-${page.label}`] = (await pageText(page)).slice(0, 2_000);
      report[`console-${page.label}`] = page.consoleLines.slice(-40);
      report[`problems-${page.label}`] = page.problems.slice(-20);
      report[`network-${page.label}`] = page.failures.slice(-40);
    } catch {}
  }
  console.error(error);
  const running = report.scenarios.at(-1);
  if (running && running.status === "running") running.status = "failed";
} finally {
  report.violationCount = report.violations.length;
  if (host) report.hostLogTail = host.log().slice(-4_000);
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {}
  }
  // 整份结果统一打码再写（错误栈、主机日志、页面控制台行里都可能带令牌）。
  writeResult(output, JSON.parse(redact(JSON.stringify(report))));
  try {
    // 主机的子进程（Agent 适配器）可能还在收尾往临时 HOME 里写：重试几次。
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  } catch (error) {
    console.log(`  warn  临时目录没删干净：${scratch}（${error.code}）`);
  }
  console.log(
    `\n${report.status}；CSP 违规 ${report.violations.length} 条；结果 ${join(output, "result.json")}`,
  );
  process.exit(report.status === "passed" ? 0 : 1);
}
