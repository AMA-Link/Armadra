// Android 模拟器的宿主侧旁观（#485）：夜间里模拟器进程在插桩中途无声消失，logcat 只剩
// 「waiting for device」，当时看不出是被系统杀（内存）、自己崩（图形后端）还是被别的进程收走。
// 这里每隔几秒记一行宿主内存、负载与模拟器进程的常驻内存，模拟器进程一消失就抓一次现场：
// 内核日志（OOM 或段错误会写在那里）、模拟器的崩溃转储目录、systemd-coredump 的摘要与线程栈、
// 占内存最多的进程。
// 只读 /proc 与几条只读命令；不在 Linux 上就什么也不做。
//
// 另有两个子命令给夜间工作流判断要不要重启模拟器重跑一次（#921）：
//   node tools/probes/android-host-watch.mjs archive <输出目录>
//     上一轮 result.json 判定为「模拟器进程中途消失」时，把这一轮的产物挪进 attempt-<n>/，
//     输出 `crashed=true`；否则什么也不挪、输出 `crashed=false`（用例断言失败不重试）。
//   node tools/probes/android-host-watch.mjs tally <输出目录>
//     数这一路一共崩了几次（attempt-*/ 与当前的 result.json），输出 `crashes=<n>`。
// 两者的输出都是 `key=value` 行，工作流直接追加进 GITHUB_OUTPUT。
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `MemAvailable` 换成 MB；读不到返回 null。 */
export function memAvailableMb(meminfo) {
  const match = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
  return match ? Math.round(Number(match[1]) / 1024) : null;
}

/** /proc 里命令行含 qemu-system 的进程（模拟器的虚拟机进程），带常驻内存 MB。 */
export function emulatorProcesses(proc = "/proc") {
  const found = [];
  let names = [];
  try {
    names = readdirSync(proc).filter((name) => /^\d+$/.test(name));
  } catch {
    return found;
  }
  for (const pid of names) {
    try {
      const cmdline = readFileSync(join(proc, pid, "cmdline"), "utf8");
      if (!cmdline.includes("qemu-system")) continue;
      const status = readFileSync(join(proc, pid, "status"), "utf8");
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
      found.push({
        pid: Number(pid),
        rssMb: rss ? Math.round(Number(rss[1]) / 1024) : null,
      });
    } catch {
      // 读的瞬间进程没了。
    }
  }
  return found;
}

/** systemd-coredump 摘要里的信号名（`Signal: 11 (SEGV)` → `SEGV`）；没有就是 null。 */
export function coredumpSignal(summary) {
  return /^\s*Signal:\s*\d+\s*\((\w+)\)/m.exec(summary)?.[1] ?? null;
}

const text = (command, args, timeout = 20_000) => {
  const done = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return `$ ${command} ${args.join(" ")}\n${done.stdout ?? ""}${done.stderr ?? ""}${done.error ? `（${done.error.message}）\n` : ""}`;
};

/**
 * 模拟器死于段错误时内核把转储交给 systemd-coredump：取它的摘要，装了 gdb 就再取各线程栈。
 * 转储是几 GB 的内存映像，要几十秒才写完，所以先等；放在后台进程里，不卡住探针自己。
 */
function coredumpJob(file, settleSeconds, timeoutMs) {
  const fd = openSync(file, "w");
  const script = `sleep ${settleSeconds}; ls -laR /tmp/android-runner/emu-crash-*.db/pending; sudo -n coredumpctl list --no-pager | tail -n 5; sudo -n coredumpctl info --no-pager -1 | head -n 60; if command -v gdb > /dev/null; then sudo -n coredumpctl gdb -1 -A '-batch -ex "thread apply all bt 12"' 2>&1 | tail -n 150; fi`;
  const child = spawn("sh", ["-c", script], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, timeoutMs);
    timer.unref();
    child.on("close", () => {
      clearTimeout(timer);
      done();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/**
 * 开始旁观，返回 `{ stop, sample }`。`dir` 里写 host-watch.log（每个采样一行）、host-watch-gone.log
 * （模拟器进程消失时的现场，只写一次）与 host-watch-coredump.log（后台取的转储摘要）。
 * `sample()` 立刻采一次并说模拟器是不是已经不见了；`stop()` 停止采样，等转储摘要取完，
 * 返回 `{ gone, signal }`（signal 是转储摘要里的信号名，取不到为 null）。
 */
export function startHostWatch({
  dir,
  intervalMs = 5_000,
  proc = "/proc",
  settleSeconds = 45,
  coredumpTimeoutMs = 240_000,
}) {
  if (!existsSync(join(proc, "meminfo")))
    return {
      stop: async () => ({ gone: false, signal: null }),
      sample: () => false,
    };
  const sampleLog = join(dir, "host-watch.log");
  const goneLog = join(dir, "host-watch-gone.log");
  let seen = false;
  let gone = false;
  let dump = Promise.resolve();
  const tick = () => {
    const emulators = emulatorProcesses(proc);
    const mem = memAvailableMb(readFileSync(join(proc, "meminfo"), "utf8"));
    const load = readFileSync(join(proc, "loadavg"), "utf8").split(" ")[0];
    appendFileSync(
      sampleLog,
      `${new Date().toISOString()} 可用内存 ${mem}MB 负载 ${load} 模拟器 ${JSON.stringify(emulators)}\n`,
    );
    if (emulators.length > 0) seen = true;
    else if (seen && !gone) {
      gone = true;
      writeFileSync(
        goneLog,
        [
          `${new Date().toISOString()} 模拟器进程不见了（之前在）`,
          text("sudo", ["-n", "dmesg", "-T"])
            .split("\n")
            .slice(-160)
            .join("\n"),
          text("ls", ["-laR", "/tmp/android-runner"]),
          text("ps", ["-eo", "pid,rss,etime,args", "--sort=-rss"])
            .split("\n")
            .slice(0, 16)
            .join("\n"),
          text("free", ["-m"]),
        ].join("\n"),
      );
      dump = coredumpJob(
        join(dir, "host-watch-coredump.log"),
        settleSeconds,
        coredumpTimeoutMs,
      );
    }
    return gone;
  };
  // 同一型号的 runner 是否更容易出事，要看是哪种 CPU。
  try {
    const model = /^model name\s*:\s*(.+)$/m.exec(
      readFileSync(join(proc, "cpuinfo"), "utf8"),
    );
    appendFileSync(sampleLog, `CPU ${model?.[1] ?? "未知"}\n`);
  } catch {
    // 没有 cpuinfo 就不记。
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    sample: tick,
    stop: async () => {
      clearInterval(timer);
      tick();
      await dump;
      if (!gone) return { gone, signal: null };
      let summary = "";
      try {
        summary = readFileSync(join(dir, "host-watch-coredump.log"), "utf8");
      } catch {
        // 转储摘要没写出来：只知道进程消失了。
      }
      return { gone, signal: coredumpSignal(summary) };
    },
  };
}

const readResult = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** mobile-shell-e2e 的 result.json 是否判定为模拟器进程中途消失（不是用例断言失败）。 */
export function emulatorCrashed(result) {
  return result?.emulatorCrashed === true;
}

const attemptDirs = (dir) =>
  readdirSync(dir).filter(
    (name) =>
      /^attempt-\d+$/.test(name) && statSync(join(dir, name)).isDirectory(),
  );

/**
 * 重跑之前（#921）：`dir/result.json` 判定为模拟器崩溃时，把 `dir` 里这一轮的文件（不含子目录）
 * 挪进 `attempt-<n>/`，重跑的产物就不会盖掉崩溃现场；返回 `{ crashed, attempt }`。
 * 没崩（用例断言失败、超时、没有 result.json）时什么也不动，返回 `{ crashed: false }`。
 */
export function archiveCrashedAttempt(dir) {
  if (!emulatorCrashed(readResult(join(dir, "result.json"))))
    return { crashed: false, attempt: null };
  const attempt = attemptDirs(dir).length + 1;
  const target = join(dir, `attempt-${attempt}`);
  mkdirSync(target);
  for (const name of readdirSync(dir)) {
    if (statSync(join(dir, name)).isFile())
      renameSync(join(dir, name), join(target, name));
  }
  return { crashed: true, attempt };
}

/** 这一路一共崩了几次：各 `attempt-*` 与当前 `result.json` 里判定为模拟器崩溃的轮数。 */
export function countCrashes(dir) {
  if (!existsSync(dir)) return 0;
  const results = [
    ...attemptDirs(dir).map((name) => join(dir, name, "result.json")),
    join(dir, "result.json"),
  ];
  return results.filter((file) => emulatorCrashed(readResult(file))).length;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, dir] = process.argv.slice(2);
  if (command === "archive" && dir) {
    const { crashed, attempt } = archiveCrashedAttempt(resolve(dir));
    console.log(`crashed=${crashed}`);
    if (crashed) console.log(`attempt=${attempt}`);
  } else if (command === "tally" && dir) {
    console.log(`crashes=${countCrashes(resolve(dir))}`);
  } else {
    console.error("用法：android-host-watch.mjs archive|tally <输出目录>");
    process.exit(2);
  }
}
