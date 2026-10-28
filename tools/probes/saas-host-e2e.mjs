// 控制台 `/h/<hostId>` 对一个已有 SaaS 部署的端到端探针（设计 saas-host-open §8.1，第一版：E2–E6）。
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
//
// 全程在页面加载前监听 `securitypolicyviolation`（含 Trusted Types），要求违规为零。控制台页面的 CSP
// 缺省换成 B7 要提的那一份（控制面现有的原样加 `img-src` / `media-src` 的 `blob:` 与设计 Q13 的
// `require-trusted-types-for 'script'`）；`ARMADRA_SAAS_CSP=current` 不换，看控制面现在的 CSP。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/web build && pnpm --filter @armadra/server build
//   # 部署的控制台页面目录挂上这份 apps/web/dist
//   NODE_EXTRA_CA_CERTS=<ca.crt> \
//   ARMADRA_SAAS_ISSUER=https://app.saas.localhost \
//   ARMADRA_SAAS_SPKI=<leaf.spki 的内容> \
//   ARMADRA_SAAS_ACCOUNTS=<accounts.json：{ owner, member } 各 { email, password }> \
//   ARMADRA_SAAS_TEAM=test-team \
//   [ARMADRA_SAAS_COMPOSE="<compose 包装脚本>"]  # 给了才做 E4 的节点重建
//   [ARMADRA_SAAS_ONLY=E2,E6] [ARMADRA_SAAS_CSP=current]
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { nodeAt, terminalRoundTrip, untilApproved } from "./platform-lib.mjs";
import { probeSession } from "./probe-session.mjs";
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
  (process.env.ARMADRA_SAAS_ONLY ?? "E2,E3,E4,E5,E6").split(","),
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

/** 设计 Q13 的 Trusted Types 叠加（控制面的 `ConsoleCSP` 随 B7 加上之前，探针替它加）。 */
const TRUSTED_TYPES_CSP =
  "require-trusted-types-for 'script'; trusted-types armadra armadra-sanitize default";
/**
 * 控制台页面的 CSP 按哪一份测：缺省 `proposed`——把控制面的 CSP 换成 B7 要提的那一份（原样
 * 加上 `img-src` / `media-src` 的 `blob:` 与 Trusted Types），验证这份改动够用；`current` 不动，
 * 看控制面现在的 CSP 拦什么。
 */
const CSP_MODE = process.env.ARMADRA_SAAS_CSP ?? "proposed";
const PROPOSED_EXTRA =
  "img-src 'self' blob: data:; media-src 'self' blob:; " + TRUSTED_TYPES_CSP;

/** WS 握手子协议里的令牌与票、Cookie：写进结果之前打码。 */
const redact = (text) =>
  String(text)
    .replace(/armadra-(relay|ticket)\.[^\s",;]+/g, "armadra-$1.<redacted>")
    .replace(/(__Host-armadra-[a-z]+)=[^\s";]+/g, "$1=<redacted>")
    .replace(/(Bearer\s+)[^\s",]+/gi, "$1<redacted>");

const report = {
  status: "failed",
  output,
  issuer: ISSUER,
  cspMode: CSP_MODE,
  violations: [],
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
      ...(CSP_MODE === "proposed"
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
      void useProposedCsp(page, message.params);
  });
  await page.call("Network.enable", {});
  if (CSP_MODE === "proposed")
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

/**
 * 控制台文档的响应换上 B7 要提的 CSP（控制面现有那份原样保留，追加 `blob:` 与 Trusted Types）。
 * 换掉（而不是叠加）响应头要整份重造响应——`continueResponse` 去不掉已解析的原 CSP；重造的响应
 * 没有对端地址，本地网络访问检查会把页面当公网来源，所以这一档的 Chrome 关掉了那项检查（只用于
 * 本地部署上的模拟）。
 */
async function useProposedCsp(page, params) {
  try {
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
        value: `${header.value}; ${PROPOSED_EXTRA}`,
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
    console.log(`  warn  换 CSP 失败：${error.message}`);
    await page
      .call("Fetch.continueRequest", { requestId: params.requestId })
      .catch(() => undefined);
  }
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

  /* ------------------------------------ E2 ------------------------------------ */
  {
    const s = scenario(
      report,
      "E2 owner 打开 /h/：待确认 → 放行 → 画布与终端",
      output,
    );
    await ownerTab.goto(hostUrl);
    const approvals = await approve(ownerTab, "owner 进入 host1");
    s.check(approvals === 1, "新浏览器先待确认，主机放行一次", approvals);
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
    s.check(
      (await ownerTab.evaluate("return globalThis.pwned ?? null;")) === null,
      "注入的主机文件内容没有执行",
    );
    await s.shot(ownerTab, "e2-owner-host");
    s.entry.status = "passed";
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

  /* ------------------------------------ E5 ------------------------------------ */
  const memberTab = await openTab(browser, memberContext, "member");
  let grantId;
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
    if (loginsBefore !== undefined && loginsAfter !== undefined)
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
    if (liveBefore !== undefined && liveAfter !== undefined)
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
    report.violations.length === 0 ? "passed" : "failed (CSP violations)";
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
  writeResult(output, report);
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
