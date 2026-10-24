import type { IDisposable, IParser } from "@xterm/xterm";

/**
 * 分出 xterm 对查询的**应答**和人的键入（#518）。
 *
 * 程序发 DA（`CSI c` / `CSI > c`）、DSR/CPR（`CSI n`）、DECRQM（`CSI $ p`）、
 * DECRQSS（`DCS $ q`）、窗口报告（`CSI t`）或 OSC 4/10/11/12 颜色查询时，
 * xterm 在解析里同步调 `onData` 把答案送出去，和键盘走的是同一个事件。同一个
 * 会话开着几个视图，每个都答一遍，多出来的就成了命令行里的垃圾字符。
 *
 * 这里在这些查询上挂**直通**钩子（返回 `false`，内建处理照常跑）：自定义钩子
 * 排在内建处理之前同步执行，内建处理又同步触发 `onData`，所以「钩子刚打过标记」
 * 之后的那次 `onData` 就是应答。标记在微任务里清掉——键盘、鼠标、焦点都是 DOM
 * 事件，排不进同一段同步解析里。应答还必须以 ESC 开头（xterm 的应答都是）。
 */
export interface QueryReplies {
  /** 这一段 `onData` 是不是刚才那个查询的应答。 */
  isReply(data: string): boolean;
  dispose(): void;
}

const ESC = "\x1b";

/** xterm 6.0 会回答的 CSI 查询（`InputHandler` 里调 `triggerDataEvent` 的那些）。 */
const CSI_QUERIES: readonly Parameters<IParser["registerCsiHandler"]>[0][] = [
  { final: "c" },
  { prefix: ">", final: "c" },
  { final: "n" },
  { prefix: "?", final: "n" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
  { final: "t" },
];

/** OSC 4 调色板、10 前景、11 背景、12 光标：`?` 查询时 xterm 回颜色。 */
const OSC_QUERIES: readonly number[] = [4, 10, 11, 12];

export function trackQueryReplies(
  parser: Pick<
    IParser,
    "registerCsiHandler" | "registerOscHandler" | "registerDcsHandler"
  >,
  schedule: (clear: () => void) => void = queueMicrotask,
): QueryReplies {
  let armed = false;
  const arm = () => {
    if (!armed) {
      armed = true;
      schedule(() => {
        armed = false;
      });
    }
    return false;
  };
  const disposables: IDisposable[] = [
    ...CSI_QUERIES.map((id) => parser.registerCsiHandler(id, arm)),
    ...OSC_QUERIES.map((id) => parser.registerOscHandler(id, arm)),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, arm),
  ];
  return {
    isReply: (data) => armed && data.startsWith(ESC),
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
