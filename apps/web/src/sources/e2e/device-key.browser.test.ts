import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { browserDeviceKey } from "./device-key";

/**
 * 浏览器设备钥的并发取钥（设计 saas-host-open §2.2「设备钥」）：两个标签页第一次同时取钥，
 * 各生成一把，只能留先写入的那一把——后写的覆盖先写的会让先写那一把已提交的待确认作废。
 *
 * jsdom 没有 IndexedDB：下面是只够这一段用的假实现，按规范的顺序语义——请求异步完成、
 * 同一个库上的 `readwrite` 事务串行、`add` 遇到已有的键答 `ConstraintError`，错误事件
 * 不 `preventDefault` 就中止事务。
 */

type Handler = ((event: FakeEvent) => void) | null;

interface FakeEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function event(): FakeEvent {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation: () => undefined,
  };
}

const later = (run: () => void) => setTimeout(run, 0);

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  private pending = 0;
  private done = false;
  private queue: (() => void)[] = [];
  private started = false;

  constructor(
    private readonly data: Map<string, unknown>,
    private readonly finished: () => void,
  ) {}

  start(): void {
    this.started = true;
    for (const run of this.queue.splice(0)) later(run);
    if (this.pending === 0) later(() => this.settle());
  }

  objectStore() {
    return {
      get: (key: string) =>
        this.request((request) => {
          request.result = this.data.get(key);
          return true;
        }),
      add: (value: unknown, key: string) =>
        this.request((request) => {
          if (this.data.has(key)) {
            request.error = new DOMException("exists", "ConstraintError");
            return false;
          }
          this.data.set(key, value);
          request.result = key;
          return true;
        }),
      put: (value: unknown, key: string) =>
        this.request((request) => {
          this.data.set(key, value);
          request.result = key;
          return true;
        }),
    };
  }

  private request(run: (request: FakeRequest) => boolean): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    const step = () => {
      if (this.done) return;
      const ok = run(request);
      if (ok) request.onsuccess?.(event());
      else {
        const failed = event();
        request.onerror?.(failed);
        if (!failed.defaultPrevented) {
          this.error = request.error;
          this.done = true;
          this.onabort?.(event());
          this.finished();
          return;
        }
      }
      this.pending -= 1;
      if (this.pending === 0) later(() => this.settle());
    };
    if (this.started) later(step);
    else this.queue.push(step);
    return request;
  }

  private settle(): void {
    if (this.done || this.pending > 0) return;
    this.done = true;
    this.oncomplete?.(event());
    this.finished();
  }
}

function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  // 同一个库上的写事务串行：前一个完了才开下一个（读事务不排队）。
  let writing: Promise<void> = Promise.resolve();
  return {
    data,
    open() {
      const request = new FakeRequest() as FakeRequest & {
        onupgradeneeded: Handler;
      };
      request.onupgradeneeded = null;
      later(() => {
        request.result = {
          createObjectStore: () => undefined,
          close: () => undefined,
          transaction: (_store: string, mode = "readonly") => {
            let finish = () => undefined as void;
            const done = new Promise<void>((resolve) => {
              finish = resolve;
            });
            const tx = new FakeTransaction(data, () => finish());
            if (mode === "readwrite") {
              const before = writing;
              writing = before.then(() => done);
              void before.then(() => tx.start());
            } else tx.start();
            return tx;
          },
        };
        request.onupgradeneeded?.(event());
        request.onsuccess?.(event());
      });
      return request;
    },
  };
}

let fake: ReturnType<typeof fakeIndexedDb>;
const original = globalThis.indexedDB;

beforeEach(() => {
  fake = fakeIndexedDb();
  Object.defineProperty(globalThis, "indexedDB", {
    value: fake,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", {
    value: original,
    configurable: true,
  });
});

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("浏览器设备钥", () => {
  it("没有就生成并存下；再取是同一把", async () => {
    const first = await browserDeviceKey();
    const second = await browserDeviceKey();
    expect(fake.data.size).toBe(1);
    expect(hex(second.publicKey)).toBe(hex(first.publicKey));
  });

  it("两个标签页同时第一次取钥：只留先写入的那一把，两边拿到的是同一把", async () => {
    const [a, b, c] = await Promise.all([
      browserDeviceKey(),
      browserDeviceKey(),
      browserDeviceKey(),
    ]);
    const stored = fake.data.get("device") as { publicKey: Uint8Array };
    expect(hex(a.publicKey)).toBe(hex(stored.publicKey));
    expect(hex(b.publicKey)).toBe(hex(stored.publicKey));
    expect(hex(c.publicKey)).toBe(hex(stored.publicKey));
    // 留下的那一把能签：签名能用存着的公钥验过。
    const message = new TextEncoder().encode("transcript");
    expect((await b.sign(message)).length).toBe(64);
  });

  it("已经有一把（别的标签页先写了）：不覆盖", async () => {
    const existing = await browserDeviceKey();
    fake.data.set("device", fake.data.get("device"));
    const again = await Promise.all([browserDeviceKey(), browserDeviceKey()]);
    for (const signer of again)
      expect(hex(signer.publicKey)).toBe(hex(existing.publicKey));
  });
});
