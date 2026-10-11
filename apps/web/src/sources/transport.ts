/**
 * 发往一个源的凭据传输：给 `fetch` 补 Bearer、给 WebSocket 先换票再升级。
 *
 * 不改写全局：每个源各包一份自己的 `fetch` 与 `WebSocket`（`api/source.ts` 的
 * 本机源、`sources/connection.ts` 的远程源），同一个页面连几台 core 时各带各的
 * 凭据。原生 App 与桌面壳的本机源用的是同一套，只是凭据的来路不同。
 */

import {
  type TransportMeter,
  meterSocket,
  meteredFetch,
} from "./traffic-meter";

/** Bearer 传输升级 WebSocket 时的票子协议前缀（core `gateway/admission.ts`）。 */
export const WS_TICKET_PROTOCOL = "armadra-ticket.";

/**
 * 经中继到达的源：HTTP 带这个头、WebSocket 多带一个 `armadra-relay.<令牌>`
 * 子协议；中继校验后剥掉再转进隧道（协议包 `RELAY_TOKEN_HEADER` /
 * `RELAY_SUBPROTOCOL_PREFIX`）。
 */
export const RELAY_TOKEN_HEADER = "armadra-relay-token";
export const RELAY_PROTOCOL = "armadra-relay.";

export interface BearerTransport {
  /** 这个源的 HTTP 来源；只改写发往它的请求。 */
  readonly origin: string;
  /**
   * WebSocket 发往的来源，和 {@link origin} 不同时给（桌面壳的流基址由壳另报，
   * `api/runtime-url.ts`）。缺省同 `origin`。
   */
  readonly socketOrigin?: string;
  /** 当前的访问密钥；没有是空串。 */
  authorization(): string;
  /**
   * 发一个（非身份面的）请求之前先备好凭据：桌面壳里还没有会话就先向壳要票
   * 配对。身份面自己的请求不经它——配对本身就是身份面的请求。
   */
  prepare?(): Promise<void>;
  /** 换一张 30 秒的一次性 WebSocket 票。 */
  wsTicket(): Promise<string>;
  /**
   * 访问密钥过期时轮转一次；成功返回 `true`。`rejected` 是被拒的那一枚：几个
   * 请求同时被拒时，别人已经换过就直接用新的。
   */
  refresh(rejected?: string): Promise<boolean>;
  /**
   * 每个请求另带的头（经中继时是中继令牌）。调用方自己带了同名头的不覆盖；
   * 身份面的请求也带——中继不分路径，没有令牌就不转。
   */
  extraHeaders?(): Record<string, string>;
  /** 升级时在票之外另带的子协议（经中继时是 `armadra-relay.<令牌>`）。 */
  extraProtocols?(): string[];
  /**
   * 底层的 `fetch` / `WebSocket`（经端到端通道时是通道的，契约 §78）；不给用全局的。
   * 每次发请求时现取：通道断了重建后换成新的那条。
   */
  baseFetch?(): typeof fetch | undefined;
  baseWebSocket?(): typeof WebSocket | undefined;
  /**
   * 经中继时的流量计量（`traffic-meter.ts`）：给了它，发往这个源的请求体、
   * 响应体与流的每条消息都记到它的源上。
   */
  readonly meter?: TransportMeter;
}

/**
 * 一个「构造时才决定是谁」的 `WebSocket` 类：每次 `new` 时问 `resolve()`，经端到端
 * 通道时是通道的类，否则全局的。给托管的流（`ManagedSocket`）与票包装用。
 */
export function deferredWebSocket(
  resolve: () => typeof WebSocket,
): typeof WebSocket {
  const placeholder = function () {} as unknown as typeof WebSocket;
  return new Proxy(placeholder, {
    construct(_target, args: [string | URL, (string | string[])?]) {
      const Ctor = resolve();
      return new Ctor(...args) as object;
    },
    get(_target, property) {
      // 常量（`OPEN` 等）与静态成员按当前的那个类答。
      return (resolve() as unknown as Record<PropertyKey, unknown>)[property];
    },
  });
}

/**
 * `target` 是不是发往 `origin`（`wss:` 当作 `https:`，`ws:` 当作 `http:`）。
 */
export function sameOrigin(target: string, origin: string): boolean {
  try {
    const url = new URL(target);
    const scheme =
      url.protocol === "wss:"
        ? "https:"
        : url.protocol === "ws:"
          ? "http:"
          : url.protocol;
    return `${scheme}//${url.host}` === origin;
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** 身份面自己管 Bearer（刷新用刷新密钥），不替它加、也不替它重试。 */
function identityPath(target: string): boolean {
  try {
    return new URL(target).pathname.startsWith("/api/identity/");
  } catch {
    return false;
  }
}

/**
 * 这次 401 是不是「会话不认了」：只有它值得换一枚访问密钥再发一次。别的 401
 * 是具名的拒绝——两步验证的码不对（`mfa_invalid_code`）、断言无效之类——重发
 * 只会再记一次失败（契约 §42.2）。认不出体的按会话失效处理（与迁移前相同）。
 */
async function sessionRefusal(response: Response): Promise<boolean> {
  if (typeof response.clone !== "function") return true;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  const code =
    body !== null && typeof body === "object" ? body.code : undefined;
  return (
    code === undefined ||
    code === "unauthenticated" ||
    code === "UNAUTHENTICATED"
  );
}

/**
 * 包一层 `fetch`：发往这个源的请求补上 `Authorization: Bearer`，401 时轮转
 * 一次再发（请求体是字符串或没有时才重发，流式的体发不了第二次）。
 *
 * 只改写发往已保存来源的请求；调用方自己带了 `Authorization` 的原样放过。
 */
export function bearerFetch(
  base: typeof fetch,
  transport: BearerTransport,
): typeof fetch {
  return async (input, init) => {
    const target = requestUrl(input);
    if (!sameOrigin(target, transport.origin)) return base(input, init);
    const identity = identityPath(target);
    if (!identity && transport.prepare)
      await transport.prepare().catch(() => undefined);
    let used = "";
    const build = () => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const token = transport.authorization();
      if (!headers.has("authorization") && token) {
        headers.set("authorization", `Bearer ${token}`);
        used = token;
      }
      for (const [name, value] of Object.entries(
        transport.extraHeaders?.() ?? {},
      )) {
        if (!headers.has(name)) headers.set(name, value);
      }
      return { ...init, headers, credentials: "omit" as const };
    };
    const send =
      transport.meter === undefined
        ? base
        : meteredFetch(base, transport.meter);
    const response = await send(input, build());
    const replayable =
      init?.body === undefined ||
      init.body === null ||
      typeof init.body === "string";
    if (
      response.status !== 401 ||
      identity ||
      !replayable ||
      new Headers(init?.headers).has("authorization") ||
      !(await sessionRefusal(response))
    )
      return response;
    if (!(await transport.refresh(used).catch(() => false))) return response;
    return send(input, build());
  };
}

/** Cookie 会话的源（服务器壳托管的页面、手机浏览器经 Gateway）。 */
export interface CookieTransport {
  /** 这个源的 HTTP 来源；只重放发往它的请求。 */
  readonly origin: string;
  /** 访问 Cookie 过期后续一次；成功答 `true`。几个请求同时被拒共用一次。 */
  refresh(): Promise<boolean>;
  /** 续上之后的 CSRF 令牌；重放的写请求带着旧的那枚时换成它。没有是空串。 */
  csrf(): string;
}

const CSRF_HEADER = "x-armadra-csrf";

/** 这份请求体能不能原样再发一次：流只能读一次。 */
function replayableBody(
  input: RequestInfo | URL,
  body: RequestInit["body"],
): boolean {
  if (body === undefined || body === null) {
    return !(input instanceof Request) || input.body === null;
  }
  return (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

/** 相对地址按页面地址补全；补不全原样返回。 */
function absoluteUrl(target: string): string {
  try {
    return new URL(target, globalThis.location?.href).href;
  } catch {
    return target;
  }
}

/**
 * 包一层 `fetch`：发往 Cookie 会话源的请求遇到「会话不认了」的 401，先续一次
 * 会话（`refresh`），续上了重放一次（契约 §3.2）。Cookie 由浏览器带，这里不加
 * 任何凭据；原请求带着 `X-Armadra-CSRF` 的换成续期后的那枚（刷新会轮换它）。
 *
 * 不重放：发往别处的、身份面自己的（它自己管刷新）、具名的 401（两步验证码不对
 * 之类）、流式请求体。续不上就把原来那次 401 交出去。
 */
export function cookieFetch(
  base: typeof fetch,
  transport: CookieTransport,
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 401) return response;
    const target = absoluteUrl(requestUrl(input));
    if (
      !sameOrigin(target, transport.origin) ||
      identityPath(target) ||
      !replayableBody(input, init?.body) ||
      !(await sessionRefusal(response))
    )
      return response;
    if (!(await transport.refresh().catch(() => false))) return response;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const csrf = transport.csrf();
    if (headers.has(CSRF_HEADER) && csrf) headers.set(CSRF_HEADER, csrf);
    return base(input, { ...init, headers });
  };
}

type SocketCtor = typeof WebSocket;

/**
 * Bearer 传输的 WebSocket：浏览器的 WS 带不了头，升级前先换一张一次性票，经
 * `Sec-WebSocket-Protocol: armadra-ticket.<票>` 升级（架构 §7）。
 *
 * 换票是异步的，而 `new WebSocket()` 是同步的，所以这里是一个「先 CONNECTING、
 * 拿到票再真连」的外壳，事件与属性都转给里面那条真连接。发往别处的连接原样
 * 交给原生实现。
 */
export function ticketedWebSocket(
  Base: SocketCtor,
  transport: Pick<
    BearerTransport,
    "origin" | "socketOrigin" | "wsTicket" | "extraProtocols" | "meter"
  >,
): SocketCtor {
  class TicketedWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    private inner: WebSocket | null = null;
    private state = 0;
    private type: BinaryType = "blob";

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = new URL(url).href;
      const offered =
        protocols === undefined
          ? []
          : Array.isArray(protocols)
            ? protocols
            : [protocols];
      void transport.wsTicket().then(
        (ticket) => {
          if (this.state === 3) return;
          const inner = new Base(this.url, [
            ...offered,
            `${WS_TICKET_PROTOCOL}${ticket}`,
            ...(transport.extraProtocols?.() ?? []),
          ]);
          if (transport.meter !== undefined)
            meterSocket(inner, this.url, transport.meter);
          inner.binaryType = this.type;
          this.inner = inner;
          for (const name of ["open", "message", "error", "close"] as const) {
            inner.addEventListener(name, (event) => this.relay(name, event));
          }
          if (this.state === 2) inner.close();
        },
        () => {
          if (this.state === 3) return;
          this.relay("error", new Event("error"));
          this.relay(
            "close",
            new CloseEvent("close", { code: 1006, wasClean: false }),
          );
        },
      );
    }

    private relay(name: "open" | "message" | "error" | "close", event: Event) {
      if (name === "close") this.state = 3;
      const copy =
        name === "message"
          ? new MessageEvent("message", {
              data: (event as MessageEvent).data,
            })
          : name === "close"
            ? new CloseEvent("close", {
                code: (event as CloseEvent).code,
                reason: (event as CloseEvent).reason,
                wasClean: (event as CloseEvent).wasClean,
              })
            : new Event(name);
      const handler = this[`on${name}`] as ((event: Event) => void) | null;
      handler?.call(this, copy);
      this.dispatchEvent(copy);
    }

    get readyState(): number {
      return this.inner?.readyState ?? this.state;
    }

    get binaryType(): BinaryType {
      return this.inner?.binaryType ?? this.type;
    }

    set binaryType(value: BinaryType) {
      this.type = value;
      if (this.inner) this.inner.binaryType = value;
    }

    get bufferedAmount(): number {
      return this.inner?.bufferedAmount ?? 0;
    }

    get protocol(): string {
      const chosen = this.inner?.protocol ?? "";
      // 票与中继令牌是门票，不是调用方协商的协议。
      return chosen.startsWith(WS_TICKET_PROTOCOL) ||
        chosen.startsWith(RELAY_PROTOCOL)
        ? ""
        : chosen;
    }

    get extensions(): string {
      return this.inner?.extensions ?? "";
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.inner === null || this.inner.readyState !== 1)
        throw new DOMException("WebSocket is not open", "InvalidStateError");
      this.inner.send(data);
    }

    close(code?: number, reason?: string): void {
      if (this.inner) {
        this.inner.close(code, reason);
        return;
      }
      if (this.state >= 2) return;
      // 票还没回来：标记为关闭中，票回来时立刻关掉，不再打开。
      this.state = 2;
      queueMicrotask(() =>
        this.relay(
          "close",
          new CloseEvent("close", { code: code ?? 1000, wasClean: true }),
        ),
      );
    }
  }

  return new Proxy(Base, {
    construct(target, args: [string | URL, (string | string[])?]) {
      return sameOrigin(
        String(args[0]),
        transport.socketOrigin ?? transport.origin,
      )
        ? new TicketedWebSocket(...args)
        : new target(...args);
    },
  });
}
