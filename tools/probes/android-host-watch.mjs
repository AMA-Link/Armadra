// Android 模拟器的宿主侧旁观（#485）：夜间里模拟器进程在插桩中途无声消失，logcat 只剩
// 「waiting for device」，当时看不出是被系统杀（内存）、自己崩（图形后端）还是被别的进程收走。
// 这里每隔几秒记一行宿主内存、负载与模拟器进程的常驻内存，模拟器进程一消失就抓一次现场：
// 内核日志（OOM 或段错误会写在那里）、模拟器的崩溃转储目录、systemd-coredump 的摘要与线程栈、
// 占内存最多的进程。
// 只读 /proc 与几条只读命令；不在 Linux 上就什么也不做。
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  readFileSync,
  openSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
 * `sample()` 立刻采一次并说模拟器是不是已经不见了；`stop()` 停止采样，并等转储摘要取完。
 */
export function startHostWatch({
  dir,
  intervalMs = 5_000,
  proc = "/proc",
  settleSeconds = 45,
  coredumpTimeoutMs = 240_000,
}) {
  if (!existsSync(join(proc, "meminfo")))
    return { stop: async () => {}, sample: () => false };
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
    },
  };
}
