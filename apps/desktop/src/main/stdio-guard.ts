import { isBrokenConsolePipe } from "../session-host/broken-pipe";

/**
 * 主进程的 stdout / stderr 断开时不弹「未捕获异常」（#961）。
 *
 * 桌面壳把 core 的每行输出回显到自己的 stderr（`runtime-process.ts`）。读这条
 * 管道的那一端先走了——从终端或脚本启动、父进程退出——之后的写入异步失败成
 * EPIPE；流上没有 `error` 监听时它会变成未捕获异常，Electron 直接弹窗。回显只是
 * 日志，管道断了就丢掉；其它错误照旧抛出，不吞。
 */
export function guardStdio(
  streams: readonly NodeJS.EventEmitter[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    stream.on("error", (error: unknown) => {
      if (!isBrokenConsolePipe(error)) throw error;
    });
  }
}
