// 探针里跑长命令（Gradle、xcodebuild）的一层壳：输出边收边写进日志文件、每隔一阵在
// 控制台打一行心跳，超时就先抓现场再把整个进程组杀掉。
//
// 为什么要有：夜间 Android 插桩那一步曾经整整 90 分钟没有任何输出——命令的输出只在退出时
// 才落盘，卡住时既看不到卡在哪，也没有任何东西会让它结束，只能等作业到点被取消（#746）。
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/** 超时被杀时 `run` 返回的退出码（真实退出码不会是这个值）。 */
export const TIMED_OUT = -2;

/**
 * @param {object} spec
 * @param {string} spec.command
 * @param {string[]} spec.args
 * @param {string} spec.log 输出日志路径，边收边写
 * @param {number} spec.timeoutMs 超过就抓现场并杀掉
 * @param {string} [spec.name] 心跳与超时提示里的名字
 * @param {number} [spec.heartbeatMs] 心跳间隔，0 关掉
 * @param {() => unknown} [spec.onTimeout] 杀之前调用，用来抓现场；抛错不影响杀进程
 * @param {object} [spec.options] 透传给 spawn
 * @param {(line: string) => void} [spec.say] 控制台输出，默认 console.log
 * @param {number} [spec.killGraceMs] SIGTERM 之后多久补 SIGKILL
 * @returns {Promise<number>} 退出码；超时为 TIMED_OUT，起不来为 -1
 */
export function boundedRun({
  command,
  args,
  log,
  timeoutMs,
  name = command,
  heartbeatMs = 60_000,
  onTimeout,
  options = {},
  say = (line) => console.log(line),
  killGraceMs = 5_000,
}) {
  return new Promise((done) => {
    const sink = createWriteStream(log);
    const started = Date.now();
    let bytes = 0;
    let lastLine = "";
    let finished = false;
    let timedOut = false;
    // 子进程自成一组，超时时连它拉起的 Gradle 守护进程一并收掉；Windows 没有进程组。
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    const keep = (chunk) => {
      sink.write(chunk);
      bytes += chunk.length;
      const text = chunk.toString("utf8").trimEnd();
      if (text) lastLine = text.slice(text.lastIndexOf("\n") + 1).slice(-160);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    const signal = (name_) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, name_);
        else child.kill(name_);
      } catch {
        // 进程已经退出，没有什么可发信号的。
      }
    };
    const finish = (code, note = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(beat);
      if (note) sink.write(`\n${note}\n`);
      sink.end(() => done(code));
    };

    const beat =
      heartbeatMs > 0
        ? setInterval(() => {
            const seconds = Math.round((Date.now() - started) / 1000);
            say(
              `  ...   ${name} 已运行 ${seconds} 秒，日志 ${bytes} 字节，末行：${lastLine || "（还没有输出）"}`,
            );
          }, heartbeatMs)
        : undefined;
    beat?.unref();

    const timer = setTimeout(async () => {
      timedOut = true;
      say(
        `  FAIL  ${name} 超过 ${Math.round(timeoutMs / 1000)} 秒还没结束，抓现场后杀掉`,
      );
      try {
        await onTimeout?.();
      } catch (error) {
        say(`  FAIL  ${name} 抓现场出错：${error}`);
      }
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), killGraceMs).unref();
      // 杀不掉（被卡在内核里）也不再等：探针要带着现场往下走。
      setTimeout(
        () => finish(TIMED_OUT, `（${name} 超时被杀）`),
        killGraceMs * 2,
      ).unref();
    }, timeoutMs);

    child.on("error", (error) => finish(-1, String(error)));
    child.on("exit", (code) => {
      if (timedOut) finish(TIMED_OUT, `（${name} 超时被杀）`);
      else finish(code ?? -1);
    });
  });
}
