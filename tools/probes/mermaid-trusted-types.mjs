// Mermaid 在强制 Trusted Types 下的渲染（设计 saas-host-open §5.4 Q13）。
//
// 控制台来源的 CSP 要求 `require-trusted-types-for 'script'` 之后，Mermaid（与它带的 DOMPurify）
// 写 HTML 的地方都要过页面的策略。这里把 `fixtures/mermaid-trusted-types/` 的页面（应用里同一份
// `lib/trusted-types.ts` 与 `renderMermaidSvg`）用 Vite 打包，起一个回环静态服务，响应头带
// 云端 `ConsoleCSP` 要的那几条指令，再用新 profile 的无头 Chrome 渲染几种图：要求每种都渲染出
// SVG、按 `blob:` 图片能显示，且 `securitypolicyviolation` 为零。
//
//   node tools/probes/mermaid-trusted-types.mjs [输出目录]
//
// 产物默认在 target/mermaid-trusted-types/result.json。
import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  connectBrowser,
  root,
  until,
  writeResult,
} from "./ui-features/harness.mjs";

/** 云端 `ConsoleCSP` 要的指令（与 `saas-host-e2e.mjs` 的 proposed 档一致）。 */
export const MERMAID_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types armadra armadra-sanitize default dompurify",
].join("; ");

/** 每种图与它渲染后必须出现的标签。 */
const DIAGRAMS = {
  flowchart: [
    "flowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| A",
    ["开始", "判断", "结束", "是"],
  ],
  sequence: [
    "sequenceDiagram\n  participant 页面\n  participant 主机\n  页面->>主机: 请求\n  主机-->>页面: 回答",
    ["页面", "主机", "请求", "回答"],
  ],
  class: [
    "classDiagram\n  class Animal {\n    +name: string\n    +speak()\n  }\n  Animal <|-- Dog",
    ["Animal", "Dog", "speak()"],
  ],
  state: [
    "stateDiagram-v2\n  [*] --> 空闲\n  空闲 --> 忙碌: 开始\n  忙碌 --> [*]",
    ["空闲", "忙碌", "开始"],
  ],
};

const output = resolve(
  process.argv[2] ?? join(root, "target/mermaid-trusted-types"),
);
mkdirSync(output, { recursive: true });
const report = {
  status: "failed",
  csp: MERMAID_CSP,
  diagrams: {},
  violations: [],
};
const scratch = mkdtempSync(join(tmpdir(), "mermaid-tt-"));
const cleanups = [];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

try {
  const web = join(root, "apps/web");
  const vite = await import(
    pathToFileURL(createRequire(join(web, "package.json")).resolve("vite")).href
  );
  const out = join(scratch, "dist");
  await vite.build({
    configFile: false,
    logLevel: "warn",
    root: join(root, "tools/probes/fixtures/mermaid-trusted-types"),
    base: "./",
    resolve: { alias: { "@": join(web, "src") } },
    build: { outDir: out, emptyOutDir: true },
  });

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const file = join(out, path === "/" ? "index.html" : path);
    if (
      !file.startsWith(out) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      response.writeHead(404).end();
      return;
    }
    // `?tt=0`：同一页面不带 Trusted Types 的那两条，作对照。
    const plain =
      new URL(request.url ?? "/", "http://x").searchParams.get("tt") === "0";
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-security-policy": plain
        ? MERMAID_CSP.split("; ")
            .filter((one) => !one.includes("trusted-types"))
            .join("; ")
        : MERMAID_CSP,
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = join(scratch, "profile");
  const chrome = spawn(
    process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  cleanups.push(() => chrome.kill("SIGKILL"));
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
  const page = await browser.page(await browser.context());
  await page.call("Runtime.addBinding", { name: "__csp" });
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `addEventListener("securitypolicyviolation", (e) => globalThis.__csp(JSON.stringify({ directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 120), sample: String(e.sample ?? "").slice(0, 120) })));`,
  });
  browser.on((message) => {
    if (
      message.sessionId === page.sessionId &&
      message.method === "Runtime.bindingCalled"
    )
      report.violations.push(JSON.parse(message.params.payload));
  });
  const renderAll = async (query) => {
    await page.goto(`${origin}/${query}`);
    await page.until(
      "return typeof globalThis.renderMermaid === 'function' ? true : null;",
      "页面就绪",
    );
    const results = {};
    for (const [name, [text]] of Object.entries(DIAGRAMS))
      results[name] = await page.evaluate(
        `const r = await globalThis.renderMermaid(${JSON.stringify(text)}); return { svg: r.svg, loaded: r.loaded, width: r.width };`,
      );
    return results;
  };
  // 对照：不强制 Trusted Types 时的渲染结果。
  const baseline = await renderAll("?tt=0");
  const enforced = await renderAll("");
  for (const [name, [, labels]] of Object.entries(DIAGRAMS)) {
    const result = enforced[name];
    const missing = labels.filter((label) => !result.svg.includes(label));
    const entry = {
      length: result.svg.length,
      baselineLength: baseline[name].svg.length,
      loaded: result.loaded,
      width: result.width,
      baselineWidth: baseline[name].width,
      missing,
    };
    report.diagrams[name] = entry;
    const ok =
      result.svg.includes("<svg") &&
      result.loaded &&
      result.width > 0 &&
      result.width === baseline[name].width &&
      missing.length === 0;
    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${name} — ${JSON.stringify(entry)}`,
    );
    if (!ok)
      throw new Error(`${name} 在强制 Trusted Types 下没有和对照一样渲染出来`);
  }
  if (report.violations.length > 0)
    throw new Error(
      `CSP 违规 ${report.violations.length} 条：${JSON.stringify(report.violations.slice(0, 5))}`,
    );
  report.status = "passed";
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {}
  }
  writeResult(output, report);
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
  console.log(
    `\n${report.status}；CSP 违规 ${report.violations.length} 条；结果 ${join(output, "result.json")}`,
  );
  process.exit(report.status === "passed" ? 0 : 1);
}
