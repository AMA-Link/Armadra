/**
 * 这台客户端经中继与每个源收发了多少字节（流量统计设计 §6.4，契约 §76 的客户端一侧）。
 *
 * 计的是页面自己看得见的明文：请求体与响应体、WebSocket 每条消息的载荷。浏览器
 * 看不到 HTTP 头、WebSocket 帧头与 TLS，所以这里的数会略小于 core 那一侧
 * （`traffic.summary` 按本设备求和）。类别表与 core 共用一份
 * （`@armadra/shared` 的 `trafficCategory`）。
 *
 * 只计经中继的流量：直连与本机不计。挂在传输层（`transport.ts` 的 `bearerFetch` /
 * `ticketedWebSocket`、`connection.ts` 的托管流），由 {@link TransportMeter} 说
 * 这一刻是不是经中继、发往哪个源。
 *
 * 落地：内存累加，每 60 秒与页面隐藏时并进 `localStorage`（按本地日、源、类别；
 * 保留 90 天）。桌面窗口、浏览器与原生 App 的 WebView 都是这一份：数据都在
 * 各自应用的私有存储里。
 */

import {
  type StreamTrafficCategory,
  TRAFFIC_CATEGORIES,
  type TrafficStreamKind,
  trafficCategory,
} from "@armadra/shared";

export const TRAFFIC_STORAGE_KEY = "armadra.traffic.v1";
export const TRAFFIC_RETENTION_DAYS = 90;
const FLUSH_INTERVAL_MS = 60_000;
/** 页面上的数字最多这么久刷新一次。 */
const NOTIFY_DELAY_MS = 1_000;
const SEPARATOR = "|";

/** 发往一个源的传输报给计量的三件事。 */
export interface TransportMeter {
  /** 记到哪个源（源表的 `sourceId`）。 */
  readonly sourceId: string;
  /** 这一刻经中继吗；不经中继的不计。 */
  active(): boolean;
  /** 这个源的 HTTP 基址：中继是 `https://<中继>/s/<源>`，分类前剥掉它的路径。 */
  base(): string;
}

export interface TrafficTotals {
  /** 源 → 本机（下行）。 */
  bytesIn: number;
  /** 本机 → 源（上行）。 */
  bytesOut: number;
  streams: number;
}

export type TrafficRange = "today" | "month" | "all";

export interface SourceTraffic {
  readonly totals: TrafficTotals;
  readonly byCategory: Readonly<
    Partial<Record<StreamTrafficCategory, TrafficTotals>>
  >;
}

type Cell = [bytesIn: number, bytesOut: number, streams: number];

const empty = (): TrafficTotals => ({ bytesIn: 0, bytesOut: 0, streams: 0 });

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地日 `YYYY-MM-DD`。 */
export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 不分配内存地算一个字符串的 UTF-8 字节数。 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** 一份消息或请求体的字节数；看不出来（流）是 0。 */
export function payloadSize(data: unknown): number {
  if (data === undefined || data === null) return 0;
  if (typeof data === "string") return utf8Length(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (data instanceof URLSearchParams) return utf8Length(data.toString());
  if (typeof FormData !== "undefined" && data instanceof FormData) {
    let size = 0;
    for (const [name, value] of data.entries()) {
      size += utf8Length(name) + payloadSize(value);
    }
    return size;
  }
  return 0;
}

interface StoredShape {
  readonly version: 1;
  readonly rows: Record<string, Cell>;
}

function readStorage(): Record<string, Cell> {
  try {
    const raw = globalThis.localStorage?.getItem(TRAFFIC_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null;
    if (parsed?.version !== 1 || typeof parsed.rows !== "object") return {};
    const rows: Record<string, Cell> = {};
    for (const [key, cell] of Object.entries(parsed.rows ?? {})) {
      if (
        Array.isArray(cell) &&
        cell.length === 3 &&
        cell.every((value) => Number.isFinite(value) && value >= 0)
      )
        rows[key] = [cell[0], cell[1], cell[2]];
    }
    return rows;
  } catch {
    return {};
  }
}

function writeStorage(rows: Record<string, Cell>): void {
  try {
    globalThis.localStorage?.setItem(
      TRAFFIC_STORAGE_KEY,
      JSON.stringify({ version: 1, rows } satisfies StoredShape),
    );
  } catch {
    // 隐私模式或配额满：内存里的数照常显示，下一轮再试。
  }
}

function splitKey(key: string): {
  day: string;
  sourceId: string;
  category: string;
} {
  const first = key.indexOf(SEPARATOR);
  const last = key.lastIndexOf(SEPARATOR);
  return {
    day: key.slice(0, first),
    sourceId: key.slice(first + 1, last),
    category: key.slice(last + 1),
  };
}

export interface TrafficLedgerOptions {
  readonly now?: () => number;
  /** 测试用：不起定时器、不挂页面事件。 */
  readonly timers?: boolean;
}

/**
 * 计量的账本：内存里没落地的 + 已落地的，读的时候合在一起。一个页面一份
 * （{@link trafficLedger}）。
 */
export class TrafficLedger {
  private pending = new Map<string, Cell>();
  private readonly listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private version = 0;
  private readonly now: () => number;

  constructor(options: TrafficLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.timers !== false) this.start();
  }

  private start(): void {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    const hidden = () => {
      if (globalThis.document?.visibilityState === "hidden") this.flush();
    };
    globalThis.document?.addEventListener?.("visibilitychange", hidden);
    globalThis.addEventListener?.("pagehide", () => this.flush());
  }

  /** 记一笔。热路径：只在内存里加。 */
  record(
    sourceId: string,
    category: StreamTrafficCategory,
    bytesIn: number,
    bytesOut: number,
    streams = 0,
  ): void {
    if (bytesIn === 0 && bytesOut === 0 && streams === 0) return;
    const key = [localDay(this.now()), sourceId, category].join(SEPARATOR);
    let cell = this.pending.get(key);
    if (cell === undefined) {
      cell = [0, 0, 0];
      this.pending.set(key, cell);
    }
    cell[0] += bytesIn;
    cell[1] += bytesOut;
    cell[2] += streams;
    this.schedule();
  }

  /** 并进持久存储，顺手清掉保留期之前的日子。 */
  flush(): void {
    const stored = readStorage();
    const cutoff = localDay(this.now() - TRAFFIC_RETENTION_DAYS * 86_400_000);
    let changed = false;
    for (const key of Object.keys(stored)) {
      if (splitKey(key).day < cutoff) {
        delete stored[key];
        changed = true;
      }
    }
    if (this.pending.size === 0 && !changed) return;
    for (const [key, cell] of this.pending) {
      const target = stored[key] ?? [0, 0, 0];
      stored[key] = [
        target[0] + cell[0],
        target[1] + cell[1],
        target[2] + cell[2],
      ];
    }
    this.pending = new Map();
    writeStorage(stored);
  }

  /** 一个源在一段时间里的合计与按类别的分项。 */
  source(sourceId: string, range: TrafficRange): SourceTraffic {
    const totals = empty();
    const byCategory: Partial<Record<StreamTrafficCategory, TrafficTotals>> =
      {};
    const today = localDay(this.now());
    const month = today.slice(0, 7);
    for (const [key, cell] of this.cells()) {
      const parts = splitKey(key);
      if (parts.sourceId !== sourceId) continue;
      if (range === "today" && parts.day !== today) continue;
      if (range === "month" && !parts.day.startsWith(month)) continue;
      if (!(TRAFFIC_CATEGORIES as readonly string[]).includes(parts.category))
        continue;
      const category = parts.category as StreamTrafficCategory;
      const into = (byCategory[category] ??= empty());
      into.bytesIn += cell[0];
      into.bytesOut += cell[1];
      into.streams += cell[2];
      totals.bytesIn += cell[0];
      totals.bytesOut += cell[1];
      totals.streams += cell[2];
    }
    return { totals, byCategory };
  }

  /** 每个源本月的合计（连接页每行尾部那一小行）。 */
  month(): Record<string, TrafficTotals> {
    const result: Record<string, TrafficTotals> = {};
    const month = localDay(this.now()).slice(0, 7);
    for (const [key, cell] of this.cells()) {
      const parts = splitKey(key);
      if (!parts.day.startsWith(month)) continue;
      const into = (result[parts.sourceId] ??= empty());
      into.bytesIn += cell[0];
      into.bytesOut += cell[1];
      into.streams += cell[2];
    }
    return result;
  }

  /** 清零一个源（存储与内存一起）。 */
  clear(sourceId: string): void {
    const stored = readStorage();
    for (const key of Object.keys(stored)) {
      if (splitKey(key).sourceId === sourceId) delete stored[key];
    }
    for (const key of [...this.pending.keys()]) {
      if (splitKey(key).sourceId === sourceId) this.pending.delete(key);
    }
    writeStorage(stored);
    this.bump();
  }

  /** 数字变了时通知（`useSyncExternalStore`）；最多一秒一次。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 每次通知加一：给 `useSyncExternalStore` 当快照。 */
  get snapshot(): number {
    return this.version;
  }

  dispose(): void {
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);
    clearTimeout(this.notifyTimer);
  }

  private *cells(): Iterable<[string, Cell]> {
    const stored = readStorage();
    for (const [key, cell] of this.pending) {
      const before = stored[key] ?? [0, 0, 0];
      stored[key] = [
        before[0] + cell[0],
        before[1] + cell[1],
        before[2] + cell[2],
      ];
    }
    yield* Object.entries(stored);
  }

  private schedule(): void {
    if (this.notifyTimer !== undefined || this.listeners.size === 0) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.bump();
    }, NOTIFY_DELAY_MS);
  }

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 一个订阅者出错不拖垮别的。
      }
    }
  }
}

let shared: TrafficLedger | undefined;

/** 这个页面的账本（第一次用时才建，模块求值时不起定时器）。 */
export function trafficLedger(): TrafficLedger {
  shared ??= new TrafficLedger();
  return shared;
}

/** 测试用：换一份账本。 */
export function setTrafficLedger(next: TrafficLedger | undefined): void {
  shared?.dispose();
  shared = next;
}

/* ------------------------------- 挂到传输上 ------------------------------- */

/** 地址相对于源基址的路径（中继基址带 `/s/<源>`）。 */
export function pathUnder(url: string, base: string): string {
  try {
    const target = new URL(url, globalThis.location?.href);
    const prefix = new URL(base).pathname.replace(/\/+$/, "");
    const path = target.pathname;
    return prefix !== "" && path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length)
      : path;
  } catch {
    return "";
  }
}

function categoryOf(
  kind: TrafficStreamKind,
  url: string,
  meter: TransportMeter,
): StreamTrafficCategory {
  return trafficCategory(kind, pathUnder(url, meter.base()));
}

const NO_BODY = new Set([101, 204, 205, 304]);

/** 响应体经一个计数的流转交出去；没有体的原样返回。 */
function countedResponse(
  response: Response,
  count: (bytes: number) => void,
): Response {
  if (
    response.body === null ||
    NO_BODY.has(response.status) ||
    typeof TransformStream === "undefined"
  )
    return response;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
  const wrapped = new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // 调用方会看 `url`（跳转之后的地址）与 `redirected`。
  Object.defineProperty(wrapped, "url", { value: response.url });
  Object.defineProperty(wrapped, "redirected", { value: response.redirected });
  return wrapped;
}

/** 包一层 `fetch`：经中继时记请求体与响应体。 */
export function meteredFetch(
  base: typeof fetch,
  meter: TransportMeter,
  ledger: () => TrafficLedger = trafficLedger,
): typeof fetch {
  return async (input, init) => {
    if (!meter.active()) return base(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const category = categoryOf("http", url, meter);
    ledger().record(meter.sourceId, category, 0, payloadSize(init?.body), 1);
    const response = await base(input, init);
    return countedResponse(response, (bytes) =>
      ledger().record(meter.sourceId, category, bytes, 0),
    );
  };
}

/** 一条已经建好的 WebSocket：之后的收发都记账。 */
export function meterSocket(
  socket: WebSocket,
  url: string,
  meter: TransportMeter,
  ledger: () => TrafficLedger = trafficLedger,
): WebSocket {
  if (!meter.active()) return socket;
  const category = categoryOf("ws", url, meter);
  const sourceId = meter.sourceId;
  ledger().record(sourceId, category, 0, 0, 1);
  socket.addEventListener("message", (event: MessageEvent) => {
    ledger().record(sourceId, category, payloadSize(event.data), 0);
  });
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    send(data);
    ledger().record(sourceId, category, 0, payloadSize(data));
  };
  return socket;
}

/**
 * 包一层 `WebSocket` 构造器：每条新连接都记账。`resolve` 在每次构造时取当时的
 * 原生实现（测试会换掉全局那个）；静态成员（`OPEN` 等）也从它那里读。
 */
export function meteredWebSocket(
  resolve: () => typeof WebSocket,
  meter: TransportMeter,
  ledger: () => TrafficLedger = trafficLedger,
): typeof WebSocket {
  // 目标只用来满足 Proxy 的形状（要可构造）；构造与静态成员都转给当时的原生实现。
  const target = (resolve() ??
    function MissingWebSocket() {}) as unknown as typeof WebSocket;
  return new Proxy(target, {
    construct(_target, args: [string | URL, (string | string[])?]) {
      const Native = resolve();
      const socket = new Native(...args);
      return meterSocket(socket, String(args[0]), meter, ledger);
    },
    get(_target, property) {
      return Reflect.get(resolve(), property);
    },
  });
}
