import { isTerminalReplyData, replyEnd } from "./replies";

/**
 * 单 pty 会话里「待答查询」的账（#518）。
 *
 * 程序的每个终端查询，每个开着的视图都会答一遍，只能有一份进 pty。账不选
 * 应答者，而是先到先收：
 *
 *   * 每个视图的输出流里扫到一次查询，该视图这一类的「见到」数加一；
 *   * 视图的第 k 份同类应答，答的就是这一类的第 k 次查询；
 *   * 第 k 次查询已经被别的视图答过，这一份丢弃；没人答过才放行；
 *   * 视图答不出来（离屏延迟、后台挂起、断开）不挡路——别的视图答上就算。
 *
 * 序号是会话级的：视图附着时从会话当前最大的「见到」数起算，几个视图看的是
 * 同一条输出流，所以第 k 次对得上。
 *
 * 没有待答查询时到来的应答（序号超过该视图见到的查询数）丢弃：没有谁在等它，
 * 放进去只会成为输入里的垃圾字符。查询超过 `REPLY_WINDOW_MS` 没人答，应答
 * 也不再放行，并把各视图的欠账记平，后面的应答不被它拖累。
 */

/** 一次查询之后多久内的应答算数。 */
export const REPLY_WINDOW_MS = 5000;

/** 跨输出块的半截转义序列最多留多少字符。 */
const MAX_PARTIAL = 512;

const ESC = "\x1b";

/** 一类应答；程序的查询按它会引来的应答归类。 */
type Kind = string;

/** 只给应答分类：认不得的（比如窗口标题 OSC）不去重，原样放行。 */
export function replyKind(reply: string): Kind | undefined {
  if (reply[1] === "[") {
    const final = reply[reply.length - 1];
    if (final === "c") return reply[2] === ">" ? "da2" : "da1";
    if (final === "n") return "dsr";
    if (final === "R") return "cpr";
    if (final === "y") return "decrpm";
    if (final === "t") return "winops";
    return undefined;
  }
  if (reply[1] === "P") return "decrqss";
  const number = /^.\](\d+);/.exec(reply)?.[1];
  return number !== undefined && ["4", "10", "11", "12"].includes(number)
    ? `osc${number}`
    : undefined;
}

/** 把 `isTerminalReplyData` 通过的一段数据拆成一条条应答。 */
export function splitReplies(data: string): string[] {
  const parts: string[] = [];
  for (let index = 0; index < data.length; ) {
    const next = replyEnd(data, index);
    if (next === undefined) return [];
    parts.push(data.slice(index, next));
    index = next;
  }
  return parts;
}

function csiQueries(params: string, final: string): Kind[] {
  if (final === "c") {
    if (params === "" || params === "0") return ["da1"];
    if (params === ">" || params === ">0") return ["da2"];
  }
  if (final === "n") {
    if (params === "6" || params === "?6") return ["cpr"];
    if (params === "5" || /^\?\d+$/.test(params)) return ["dsr"];
  }
  if (final === "p" && params.endsWith("$")) return ["decrpm"];
  if (final === "t") {
    const first = Number(params.split(";")[0]);
    if ([11, 13, 14, 15, 16, 18, 19].includes(first)) return ["winops"];
  }
  return [];
}

function oscQueries(body: string): Kind[] {
  const [head, ...specs] = body.split(";");
  const number = Number(head);
  if (number === 4) {
    // `4;index;spec;index;spec…`：每个 `?` 一份颜色应答。
    return specs
      .filter((spec, at) => at % 2 === 1 && spec === "?")
      .map(() => "osc4");
  }
  if (number >= 10 && number <= 12) {
    // `10;spec;spec`：第 i 项对应 10 + i，项数不超过 12。
    return specs.flatMap((spec, at) =>
      spec === "?" && number + at <= 12 ? [`osc${number + at}`] : [],
    );
  }
  return [];
}

/**
 * 在一段输出里找终端查询。返回找到的、按出现顺序的各类查询，以及末尾没收完
 * 的半截序列（带着它扫下一块）。
 */
export function scanQueries(text: string): { kinds: Kind[]; rest: string } {
  const kinds: Kind[] = [];
  const partial = (at: number) => ({
    kinds,
    rest: text.length - at <= MAX_PARTIAL ? text.slice(at) : "",
  });
  let index = 0;
  for (;;) {
    const at = text.indexOf(ESC, index);
    if (at < 0) return { kinds, rest: "" };
    const kind = text[at + 1];
    if (kind === undefined) return partial(at);
    if (kind === "[") {
      let end = at + 2;
      while (end < text.length && text.charCodeAt(end) <= 0x3f) {
        if (text.charCodeAt(end) < 0x20) break;
        end += 1;
      }
      if (end >= text.length) return partial(at);
      const code = text.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) {
        kinds.push(...csiQueries(text.slice(at + 2, end), text[end]!));
        index = end + 1;
      } else {
        index = at + 1;
      }
      continue;
    }
    if (kind === "]" || kind === "P") {
      let end = -1;
      let stop = at + 1;
      let closed = false;
      for (let scan = at + 2; scan < text.length; scan += 1) {
        const char = text[scan];
        if (char === "\x07" && kind === "]") {
          end = scan;
          stop = scan + 1;
          closed = true;
          break;
        }
        if (char === ESC) {
          if (scan + 1 >= text.length) return partial(at);
          if (text[scan + 1] === "\\") {
            end = scan;
            stop = scan + 2;
          } else {
            stop = scan;
          }
          closed = true;
          break;
        }
      }
      if (!closed) return partial(at);
      if (end >= 0) {
        const body = text.slice(at + 2, end);
        if (kind === "]") kinds.push(...oscQueries(body));
        else if (body.startsWith("$q")) kinds.push("decrqss");
      }
      index = Math.max(stop, at + 1);
      continue;
    }
    index = at + 1;
  }
}

interface View {
  /** 这个视图的输出流里见到的各类查询数（会话级序号）。 */
  readonly seen: Map<Kind, number>;
  /** 这个视图已经答过的各类应答数。 */
  readonly replied: Map<Kind, number>;
  /** 上一块输出末尾没收完的半截序列。 */
  tail: string;
}

interface Session {
  readonly views: Map<number, View>;
  /** 各类查询里最大的「见到」数。 */
  readonly asked: Map<Kind, number>;
  /** 各类查询里已经放行了应答的最大序号。 */
  readonly answered: Map<Kind, number>;
  /** 各类查询最近一次出现的时刻。 */
  readonly lastAsked: Map<Kind, number>;
}

const count = (map: Map<Kind, number>, kind: Kind) => map.get(kind) ?? 0;

export class QueryLedger {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly clock: () => number,
    private readonly windowMs = REPLY_WINDOW_MS,
  ) {}

  attach(sessionId: string, id: number): void {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = {
        views: new Map(),
        asked: new Map(),
        answered: new Map(),
        lastAsked: new Map(),
      };
      this.sessions.set(sessionId, session);
    }
    // 之前的查询与这个视图无关：从会话现在的序号起算。
    session.views.set(id, {
      seen: new Map(session.asked),
      replied: new Map(session.asked),
      tail: "",
    });
  }

  detach(sessionId: string, id: number): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.views.delete(id);
    if (session.views.size === 0) this.sessions.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 视图 `id` 的输出流来了一块文本。 */
  output(sessionId: string, id: number, text: string): void {
    const session = this.sessions.get(sessionId);
    const view = session?.views.get(id);
    if (session === undefined || view === undefined) return;
    const { kinds, rest } = scanQueries(view.tail + text);
    view.tail = rest;
    const now = this.clock();
    for (const kind of kinds) {
      const last = session.lastAsked.get(kind);
      if (last !== undefined && now - last > this.windowMs) {
        // 上一次查询没人答完又过了很久：旧账作废，各视图记平。
        for (const other of session.views.values()) {
          other.replied.set(kind, count(other.seen, kind));
        }
        session.answered.set(kind, count(session.asked, kind));
      }
      const seen = count(view.seen, kind) + 1;
      view.seen.set(kind, seen);
      if (seen > count(session.asked, kind)) session.asked.set(kind, seen);
      session.lastAsked.set(kind, now);
    }
  }

  /** 视图 `id` 此刻有没有等着它答的查询：`data` 的每一条应答都对得上。 */
  expects(sessionId: string, id: number, data: string): boolean {
    const session = this.sessions.get(sessionId);
    const view = session?.views.get(id);
    if (session === undefined || view === undefined) return false;
    if (!isTerminalReplyData(data)) return false;
    const parts = splitReplies(data);
    const wanted = new Map<Kind, number>();
    for (const part of parts) {
      const kind = replyKind(part);
      if (kind === undefined) return false;
      const need = (wanted.get(kind) ?? 0) + 1;
      wanted.set(kind, need);
      if (
        count(view.seen, kind) - count(view.replied, kind) < need ||
        !this.fresh(session, kind)
      ) {
        return false;
      }
    }
    return parts.length > 0;
  }

  /**
   * 视图 `id` 的一段应答；返回该写进 pty 的部分（可能是空串）。认不得类别的
   * 应答不去重，原样放行。
   */
  accept(sessionId: string, id: number, data: string): string {
    const session = this.sessions.get(sessionId);
    const view = session?.views.get(id);
    if (session === undefined || view === undefined) return "";
    let out = "";
    for (const part of splitReplies(data)) {
      const kind = replyKind(part);
      if (kind === undefined) {
        out += part;
        continue;
      }
      const index = count(view.replied, kind) + 1;
      // 没有待答的查询：没人在等，丢弃，也不记账。
      if (index > count(view.seen, kind)) continue;
      view.replied.set(kind, index);
      if (index <= count(session.answered, kind)) continue;
      if (!this.fresh(session, kind)) continue;
      session.answered.set(kind, index);
      out += part;
    }
    return out;
  }

  private fresh(session: Session, kind: Kind): boolean {
    const last = session.lastAsked.get(kind);
    return last !== undefined && this.clock() - last <= this.windowMs;
  }
}
