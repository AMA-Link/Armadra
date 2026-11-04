// 手机壳冒烟（补全计划 G3-1，B 档）：模拟器里的原生 App 走「连接 → 配对 → 画布」。
//
// 真进程：`apps/desktop/out/core/main.js` 以桌面模式起在临时数据目录上，经回环的
// `PUT /api/gateway` 打开 Gateway（本地 CA，只在回环上监听），经 `connect.offer` 铸一张二维码
// （回环来源靠 `ARMADRA_CONNECT_INCLUDE_LOOPBACK` 放进去），把它的文本
// `https://127.0.0.1:<端口>/#c=2&…`（契约 §99.2）交给模拟器里的 UI 用例，由用例填进连接页：
//
//   * iOS：`xcodebuild test` 跑 `AppUITests`（XCUITest），模拟器与宿主共用回环；
//     用例要用链接时才经 `TEST_RUNNER_ARMADRA_PAIR_LINK_SOURCE`（回环上的一个地址）
//     向探针现铸一张——票只有两分钟，而 `xcodebuild` 起到用例点「连接」要一到三分钟。
//   * Android：`adb reverse` 把模拟器的回环端口接到宿主，`connectedDebugAndroidTest`
//     跑 `ConnectFlowTest`（插桩），链接经插桩参数 `armadraPairLink` 交进去。
//
// 连接表非空时启动先落在「选择服务」（A7-1），用例点配对的那一行才进画布；Android 另记一个
// 连不上的连接，走「两个连接 → 选择页 → 选它 → 切换服务 → 回选择页」。
//
// UI 用例在连接页填链接、点「连接」：原生先取 `/ca.crt` 按指纹钉住信任锚（App 不装
// CA），再用票配对拿 Bearer 会话，页面进画布（底部导航出现）——之后页面的 fetch 与
// WebSocket 都经钉扎过的 TLS 走 Gateway。
//
// 配对之后再两条（G5-22）：
//
//   * 原生 OAuth 的深链 `armadra://oauth?state=…&code=…`（R-56）：App 把它写进 `#link=`
//     重载，入口在挂载前向 core 收尾，结果写成 `#oauth=` 打开「账号与设备」页。Android 用例
//     先在页面里记一条假的挂起流程，再以深链冷启动 App，断言收尾请求发了（记录取走）、
//     「账号与设备」页打开；iOS 用例经深链打开、断言 App 仍在已连接的界面上。
//   * 图片带 Bearer（R-55，只 Android）：探针经回环上传一张 PNG 资产，用例在页面里断言
//     直接 `<img>` 取不到（401）、带上 Keystore 里这台 Gateway 的访问密钥再 `fetch` 取得到
//     （`useAssetUrl` 经本机源的 fetch 走的那条；页面不再改写全局 fetch）。
//
// 前置（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   pnpm --filter @armadra/mobile sync
//   iOS：Xcode 与一台可用的 iOS 模拟器；Android：已起的模拟器（adb 看得到）与 JDK 21
//
// 用法：
//   node tools/probes/mobile-shell-e2e.mjs --platform ios [--device "iPhone 16"|auto] [输出目录]
//   node tools/probes/mobile-shell-e2e.mjs --platform android [输出目录]
//
// 产物：<输出目录>/result.json，默认 target/mobile-shell-e2e/。一切都是临时的、回环的；
// core 用临时 HOME（`probe-home.mjs`），不读操作员的 CLI 登录状态。
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { TIMED_OUT, boundedRun } from "./bounded-run.mjs";
import { harness } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const platform = option("--platform", "ios");
const device = option("--device", "auto");
if (platform !== "ios" && platform !== "android") {
  console.error(`--platform 只认 ios / android，收到 ${platform}`);
  process.exit(2);
}
const output = resolve(
  args[0] ?? join(root, `target/mobile-shell-e2e/${platform}`),
);
mkdirSync(output, { recursive: true });
const h = harness(output);
// 临时 HOME 只给 core：xcodebuild / Gradle 是工具链，照常用自己的缓存。
const home = probeHome("armadra-mobile-e2e-home-");
h.cleanups.push(home.remove);
const { report, step, temp } = h;
report.platform = platform;
report.failures = [];

function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 回环上的 core：本机 owner，不带来源。 */
function local(base, method, path, body) {
  const url = new URL(path, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, failed) => {
    const client = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers:
          payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

const webDist = join(root, "apps/web/dist");

async function startCore(dataDir) {
  const entry = join(root, "apps/desktop/out/core/main.js");
  const child = spawn(
    process.execPath,
    [entry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(home, {
        ARMADRA_CORE: "ts",
        ARMADRA_NO_GLOBAL_WRITES: "1",
        ARMADRA_SECRET_BACKEND: "file",
        ARMADRA_GATEWAY_WEB_ROOT: webDist,
        ARMADRA_CONNECT_INCLUDE_LOOPBACK: "1",
      }),
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stdout.resume();
  const address = await new Promise((done, failed) => {
    const timer = setTimeout(
      () => failed(new Error(`core 没有报地址：\n${stderr}`)),
      30_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = /Armadra core is listening .*"spec":"tcp:([^"]+)"/.exec(
        stderr,
      );
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      failed(new Error(`core 退出 ${code}：\n${stderr}`));
    });
  });
  h.cleanups.push(
    () =>
      new Promise((done) => {
        child.once("exit", () => done());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  );
  return `http://${address}`;
}

/** 单条命令的默认上限；慢的（Gradle 构建）与快的（adb）各自传 `timeoutMs`。 */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * 跑一个命令，输出边收边落进 <输出目录>/<name>.log，控制台每分钟一行心跳，返回退出码。
 * 超过 `timeoutMs` 先调 `onTimeout` 抓现场、再杀掉整个进程组，返回 TIMED_OUT（#746：以前这里
 * 没有上限，卡住的 Gradle 把作业拖到 90 分钟被取消，既没有现场也没有失败报告）。
 */
function run(name, command, commandArgs, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onTimeout,
    ...spawnOptions
  } = options;
  return boundedRun({
    name,
    command,
    args: commandArgs,
    log: join(output, `${name}.log`),
    timeoutMs,
    onTimeout,
    options: spawnOptions,
  });
}

/** `auto`：最新 iOS 运行时里第一台可用的 iPhone 模拟器。 */
function simulator(name) {
  if (name !== "auto") return name;
  const listed = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (listed.status !== 0)
    throw new Error(
      `xcrun simctl 不可用（${listed.error?.message ?? listed.stderr}）：Xcode 的模拟器组件没装好`,
    );
  const runtimes = Object.entries(JSON.parse(listed.stdout).devices ?? {})
    .filter(([runtime]) => runtime.includes("iOS"))
    .sort(([a], [b]) => b.localeCompare(a, "en", { numeric: true }));
  for (const [, devices] of runtimes) {
    const phone = devices.find((entry) => entry.name.startsWith("iPhone"));
    if (phone) return phone.name;
  }
  throw new Error("没有可用的 iPhone 模拟器");
}

const UI_TEST = "AppUITests/ConnectFlowUITests";

/**
 * 模拟器日志（#281）：App 自己的几行（插件只记结果，不记密钥）、WebKit 的进程事件（WebContent /
 * GPU 进程起得多慢、被判无响应、被结束——页面空白时看这里）、以及 SpringBoard / runningboardd
 * 记的 App 进程退出（谁结束了它、为什么）。插件用 info 级，不在磁盘上留：事后 `log show` 不加
 * `--info` 只剩表头，所以测试期间另开一路 `log stream`。
 */
const SIMULATOR_LOG_PREDICATE = [
  'subsystem == "dev.armadra.mobile"',
  '(process == "App" AND subsystem == "com.apple.WebKit" AND category == "Process" AND messageType >= 16)',
  '(process IN {"SpringBoard", "runningboardd"} AND eventMessage CONTAINS "dev.armadra.mobile>" AND (eventMessage CONTAINS "Process exited" OR eventMessage CONTAINS "requested termination"))',
].join(" OR ");

/** 测试期间一直开着的 `log stream`，写进 <输出目录>/simulator-stream.log；返回收尾函数。 */
function streamSimulatorLog(target) {
  const file = createWriteStream(join(output, "simulator-stream.log"));
  const child = spawn(
    "xcrun",
    [
      "simctl",
      "spawn",
      target,
      "log",
      "stream",
      "--level",
      "info",
      "--style",
      "compact",
      "--predicate",
      SIMULATOR_LOG_PREDICATE,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(file);
  child.stderr.pipe(file);
  let stopped = false;
  const stop = () =>
    new Promise((done) => {
      if (stopped || child.exitCode !== null) {
        stopped = true;
        file.end(done);
        return;
      }
      stopped = true;
      child.once("exit", () => file.end(done));
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    });
  h.cleanups.push(stop);
  return stop;
}

/** 测试期间宿主上新出现的 App 崩溃报告（模拟器里的崩溃也落在宿主的这个目录）。 */
function collectCrashReports(since) {
  const source = join(homedir(), "Library/Logs/DiagnosticReports");
  let names = [];
  try {
    names = readdirSync(source);
  } catch {
    return 0;
  }
  const crashes = join(output, "crash");
  let copied = 0;
  for (const name of names) {
    if (!/^(App|com\.apple\.WebKit)[-_.].*\.(ips|crash)$/.test(name)) continue;
    const path = join(source, name);
    try {
      if (statSync(path).mtimeMs < since) continue;
      mkdirSync(crashes, { recursive: true });
      copyFileSync(path, join(crashes, name));
      copied += 1;
    } catch {
      /* 读不到就算了，不挡测试结果。 */
    }
  }
  return copied;
}

/**
 * 用例要用链接时才铸票：回环上的一个地址，每次 GET 现铸一张、正文是深链。
 * 票只有两分钟，而 `xcodebuild test-without-building` 从启动到用例点「连接」
 * 慢时超过两分钟（nightly 40780780654：铸票 22:44:51，点「连接」22:47:34，
 * 页面答「配对链接已失效」）。
 */
async function mintOnDemand(mint) {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/pair-link") {
      response.writeHead(404).end();
      return;
    }
    mint().then(
      (link) => {
        response.writeHead(200, { "content-type": "text/plain" }).end(link);
      },
      (error) => {
        response
          .writeHead(500, { "content-type": "text/plain" })
          .end(String(error));
      },
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/pair-link`,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/** 先把要编译的都编完、跑完「没有 Gateway」那条，再让用例在用到时现铸配对票。 */
async function ios(mint) {
  const target = simulator(device);
  step("iOS 模拟器", target);
  // 先自己起好：xcodebuild 跑完不关它，之后才读得到 App 的设备日志。
  await run("simulator-boot", "xcrun", ["simctl", "boot", target]);
  const since = Date.now();
  const stopLog = streamSimulatorLog(target);
  const common = [
    "-project",
    join(root, "apps/mobile/ios/App/App.xcodeproj"),
    "-scheme",
    "App",
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,name=${target}`,
    "-derivedDataPath",
    join(output, "DerivedData"),
  ];
  const built = await run("xcodebuild-build", "xcodebuild", [
    "build-for-testing",
    ...common,
  ]);
  check(built === 0, "模拟器构建（本地签名）", `xcodebuild exit ${built}`);
  if (built !== 0) return;
  const first = await run("xcodebuild-test-1", "xcodebuild", [
    "test-without-building",
    ...common,
    "-resultBundlePath",
    join(output, "AppUITests-1.xcresult"),
    `-only-testing:${UI_TEST}/test1WithoutAGatewayTheAppOpensOnTheConnectScreen`,
  ]);
  check(first === 0, "XCUITest：没有 Gateway 时是连接页", `exit ${first}`);
  const source = await mintOnDemand(mint);
  const second = await run(
    "xcodebuild-test-2",
    "xcodebuild",
    [
      "test-without-building",
      ...common,
      "-resultBundlePath",
      join(output, "AppUITests-2.xcresult"),
      `-only-testing:${UI_TEST}/test2PairsThroughThePinnedGatewayAndOpensTheCanvas`,
    ],
    {
      env: {
        ...process.env,
        TEST_RUNNER_ARMADRA_PAIR_LINK_SOURCE: source.url,
      },
    },
  ).finally(() => source.close());
  await stopLog();
  // 事后再从设备上取一遍（`--info`：插件的那几行是 info 级）；流断了时还有这一份。
  await run("simulator-log", "xcrun", [
    "simctl",
    "spawn",
    target,
    "log",
    "show",
    "--last",
    "30m",
    "--info",
    "--style",
    "compact",
    "--predicate",
    SIMULATOR_LOG_PREDICATE,
  ]);
  const crashes = collectCrashReports(since);
  step(
    "模拟器日志与崩溃报告",
    `simulator-stream.log、simulator-log.log、崩溃报告 ${crashes} 份`,
  );
  check(
    second === 0,
    "XCUITest：填二维码链接 → 钉扎 → 配对 → 画布 → 重开落在选择服务 → 选它进画布 → 原生 OAuth 深链",
    `exit ${second}`,
  );
}

/** 等 Google Play 服务的进程号连续 20 秒不变（最多 3 分钟）；没有这个进程（非 Google 镜像）就直接过。 */
async function settleGms() {
  let last = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pid = spawnSync("adb", ["shell", "pidof", "com.google.android.gms"], {
      encoding: "utf8",
      timeout: 30_000,
    }).stdout.trim();
    if (pid === "") return;
    if (pid !== last) {
      last = pid;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 20_000) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** adb 与宿主命令的现场抓取各自的上限；现场抓不到也不能把探针再卡住。 */
const SNAPSHOT_STEP_MS = 30_000;

/**
 * 插桩用例超时时抓的现场（#746）：设备在不在、前台是谁（系统弹的「无响应」对话框会盖住被测
 * 应用）、被测进程还在不在、整段 logcat 与一张截图，以及宿主上 Gradle 各 JVM 的线程栈
 * （看是客户端在等设备，还是守护进程里的哪个线程）。每一项独立，任何一项失败只记一行。
 */
function snapshotAndroid(tag) {
  const save = (file, text) =>
    writeFileSync(join(output, `${tag}-${file}`), text ?? "");
  const text = (command, commandArgs) => {
    const done = spawnSync(command, commandArgs, {
      encoding: "utf8",
      timeout: SNAPSHOT_STEP_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return `$ ${command} ${commandArgs.join(" ")}\n${done.stdout ?? ""}${done.stderr ?? ""}${done.error ? `\n（${done.error.message}）` : ""}\n`;
  };
  const device = (shell) => text("adb", ["shell", shell]);
  try {
    save(
      "device.log",
      [
        text("adb", ["devices", "-l"]),
        device("getprop sys.boot_completed; getprop ro.build.fingerprint"),
        device(
          "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|isKeyguardShowing'",
        ),
        device(
          "dumpsys activity activities | grep -E 'ResumedActivity|topResumedActivity'",
        ),
        device("ps -A | grep -E 'armadra|instrument|gms|systemui'"),
        device("dumpsys meminfo | head -n 30"),
        device(
          "dumpsys activity processes | grep -E 'ANR|not responding' | head -n 20",
        ),
      ].join("\n"),
    );
    save(
      "logcat-full.log",
      text("adb", ["logcat", "-d", "-t", "4000", "-v", "threadtime"]),
    );
    const shot = spawnSync("adb", ["exec-out", "screencap", "-p"], {
      timeout: SNAPSHOT_STEP_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (shot.status === 0 && shot.stdout?.length)
      writeFileSync(join(output, `${tag}-screen.png`), shot.stdout);
    const host = [text("ps", ["-eo", "pid,etime,args"])];
    const jps = spawnSync("jps", ["-l"], {
      encoding: "utf8",
      timeout: SNAPSHOT_STEP_MS,
    });
    host.push(`$ jps -l\n${jps.stdout ?? ""}`);
    for (const line of (jps.stdout ?? "").split("\n")) {
      const pid = line.split(" ")[0];
      if (/^\d+$/.test(pid) && /gradle/i.test(line))
        host.push(text("jstack", [pid]));
    }
    save("host.log", host.join("\n"));
    step(
      "超时现场",
      `${tag}-device.log、${tag}-logcat-full.log、${tag}-screen.png、${tag}-host.log`,
    );
  } catch (error) {
    console.error(`  FAIL  抓现场出错：${error}`);
  }
}

/** 一次 Gradle 插桩（或构建）跑的最长时间；正常 1 到 3 分钟，留足冷启动余量。 */
const GRADLE_BUILD_TIMEOUT_MS = 15 * 60_000;
const GRADLE_CONNECTED_TIMEOUT_MS = 12 * 60_000;
/** 插桩里单条用例的上限（AndroidJUnitRunner 的 timeout_msec）：卡在某个等待点的用例到点就报错，不拖着整次运行。 */
const TEST_TIMEOUT_MS = 4 * 60_000;

const timedOutNote = (code) => (code === TIMED_OUT ? "，超时被杀" : "");

async function android(mint, port, assetUrl) {
  const reversed = await run(
    "adb-reverse",
    "adb",
    ["reverse", `tcp:${port}`, `tcp:${port}`],
    { timeoutMs: 60_000 },
  );
  check(reversed === 0, "adb reverse 把模拟器回环接到宿主", `tcp:${port}`);
  const gradlew = join(root, "apps/mobile/android/gradlew");
  const cwd = join(root, "apps/mobile/android");
  const built = await run(
    "gradle-build",
    gradlew,
    [":app:assembleDebug", ":app:assembleDebugAndroidTest", "--stacktrace"],
    { cwd, timeoutMs: GRADLE_BUILD_TIMEOUT_MS },
  );
  check(
    built === 0,
    "debug APK 与插桩 APK",
    `gradle exit ${built}${timedOutNote(built)}`,
  );
  if (built !== 0) return;
  // 模拟器刚启动时 Google Play 服务常在自更新、重启（logcat：“forcing restart due to module”），
  // 连带杀掉同时起着的被测进程，插桩只报 “Process crashed”。先等它的进程号稳住，崩了再来一次（夜间 #372）。
  await settleGms();
  let code = 1;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 配对链接是现铸、两分钟内有效的，重试要重铸。
    const link = await mint();
    const name = attempt === 1 ? "gradle-connected" : "gradle-connected-retry";
    code = await run(
      name,
      gradlew,
      [
        ":app:connectedDebugAndroidTest",
        `-Pandroid.testInstrumentationRunnerArguments.armadraPairLink=${link}`,
        `-Pandroid.testInstrumentationRunnerArguments.armadraAssetUrl=${assetUrl}`,
        `-Pandroid.testInstrumentationRunnerArguments.timeout_msec=${TEST_TIMEOUT_MS}`,
        "--stacktrace",
      ],
      {
        cwd,
        timeoutMs: GRADLE_CONNECTED_TIMEOUT_MS,
        onTimeout: () => snapshotAndroid(name),
      },
    );
    // 超时是卡住，不是进程被杀：重跑只会再卡一轮，直接带着现场失败。
    if (code === 0 || code === TIMED_OUT) break;
    const crashed = readFileSync(join(output, `${name}.log`), "utf8").includes(
      "Process crashed",
    );
    if (!crashed) break;
    step(`插桩进程被系统杀掉（第 ${attempt} 次）`, "等 Play 服务稳住后重跑");
    await settleGms();
  }
  // 失败时最有用的是 WebView 控制台与插件自己的几行（不含任何密钥）。
  await run(
    "logcat",
    "adb",
    [
      "logcat",
      "-d",
      "-s",
      "ArmadraNative:*",
      "chromium:*",
      // 进程崩了时插桩只说「Process crashed」：栈在 AndroidRuntime 里。
      "AndroidRuntime:E",
      // 页面里的 console（只有错误与提示，不含密钥）。
      "Capacitor/Console:*",
    ],
    { timeoutMs: 2 * 60_000 },
  );
  check(
    code === 0,
    "插桩用例：连接页 → 钉扎 → 配对 → 画布 → 两个连接重开落在选择服务 → 选它进画布 → 切换服务回选择页；图片带 Bearer；原生 OAuth 深链收尾",
    `gradle exit ${code}${timedOutNote(code)}`,
  );
}

await h.run(async () => {
  for (const required of [
    join(root, "apps/desktop/out/core/main.js"),
    join(webDist, "index.html"),
    join(
      root,
      platform === "ios"
        ? "apps/mobile/ios/App/App/public/index.html"
        : "apps/mobile/android/app/src/main/assets/public/index.html",
    ),
  ]) {
    if (!existsSync(required))
      throw new Error(`缺 ${required}：先按文件头的前置步骤构建`);
  }

  const base = await startCore(temp("armadra-mobile-e2e-"));
  step("core 起在回环上", base);

  const opened = JSON.parse(
    (
      await local(base, "PUT", "/api/gateway", {
        enabled: true,
        listen: "loopback",
      })
    ).body,
  );
  check(
    opened.running && opened.tls?.source === "localCa",
    "Gateway 开在回环上（本地 CA）",
    opened.origin,
  );
  const origin = new URL(opened.origin);

  const mint = async () => {
    const offer = JSON.parse(
      (await local(base, "POST", "/api/rpc/connect/offer", {})).body,
    ).json;
    check(
      typeof offer.uri === "string" &&
        offer.uri.startsWith(`${offer.direct.origins[0]}/#c=2&`) &&
        /&f=[A-Za-z0-9_-]{43}(&|$)/.test(offer.uri),
      "二维码是带信任锚的网页链接（现铸，两分钟内用）",
      offer.direct?.fingerprint,
    );
    return offer.uri;
  };

  // 一张 1×1 的 PNG：页面经 Gateway 取它时要带 Bearer（R-55）。
  const created = JSON.parse(
    (
      await local(base, "POST", "/api/workspaces", {
        name: "mobile-shell-e2e",
        rootPath: temp("armadra-mobile-e2e-workspace-"),
      })
    ).body,
  );
  const uploaded = JSON.parse(
    (
      await local(base, "POST", `/api/workspaces/${created.id}/assets`, {
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      })
    ).body,
  );
  check(
    typeof created.id === "string" && typeof uploaded.id === "string",
    "工作空间与一张 PNG 资产（回环上传）",
    uploaded.id,
  );
  const assetUrl = `${opened.origin}/api/workspaces/${created.id}/assets/${encodeURIComponent(uploaded.id ?? "")}`;

  if (platform === "ios") await ios(mint);
  else await android(mint, origin.port, assetUrl);
});
