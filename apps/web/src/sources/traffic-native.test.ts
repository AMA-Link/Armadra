import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStorage } from "../mobile/testing";
import {
  NativeTrafficStorage,
  TRAFFIC_STORAGE_KEY,
  TrafficLedger,
  localDay,
} from "./traffic-meter";

/** 手机的客户端流量落在原生存储（设计 §6.4）：读到之后才落地，旧 localStorage 一次性迁移。 */

const NOW = new Date(2026, 9, 12, 10, 0, 0).getTime();
const DAY = localDay(NOW);

interface Row {
  day: string;
  sourceId: string;
  category: string;
  bytesIn: number;
  bytesOut: number;
  streams: number;
}

/** 假的原生插件：内存里一份，记下每次 save。 */
function installNative(initial: Row[] | "broken") {
  const state = {
    rows: initial === "broken" ? [] : initial,
    saves: [] as Row[][],
    broken: initial === "broken",
  };
  vi.stubGlobal("location", new URL("capacitor://localhost/"));
  vi.stubGlobal("Capacitor", {
    isNativePlatform: () => true,
    Plugins: {
      ArmadraNative: {
        trafficLoad: async () => {
          if (state.broken) throw new Error("native down");
          return { rows: state.rows };
        },
        trafficSave: async ({ rows }: { rows: Row[] }) => {
          state.saves.push(rows);
          state.rows = rows;
        },
      },
    },
  });
  return state;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newLedger() {
  const storage = new NativeTrafficStorage();
  const ledger = new TrafficLedger({
    now: () => NOW,
    timers: false,
    storage,
  });
  return { storage, ledger };
}

describe("原生流量存储", () => {
  it("读到之前不落地（不会盖掉原生里的历史），读到后并进去再写回", async () => {
    const native = installNative([
      {
        day: DAY,
        sourceId: "src1",
        category: "api",
        bytesIn: 100,
        bytesOut: 10,
        streams: 1,
      },
    ]);
    const { storage, ledger } = newLedger();
    ledger.record("src1", "api", 5, 0);
    ledger.flush();
    expect(native.saves).toEqual([]);
    await storage.hydrate();
    ledger.flush();
    expect(native.saves.at(-1)).toEqual([
      {
        day: DAY,
        sourceId: "src1",
        category: "api",
        bytesIn: 105,
        bytesOut: 10,
        streams: 1,
      },
    ]);
    expect(ledger.source("src1", "all").totals.bytesIn).toBe(105);
  });

  it("旧 localStorage 的数一次性并进原生存储并删掉，之后不再读那条路", async () => {
    const native = installNative([]);
    localStorage.setItem(
      TRAFFIC_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        rows: { [`${DAY}|src1|files`]: [7, 3, 2] },
      }),
    );
    const { storage, ledger } = newLedger();
    await expect(storage.hydrate()).resolves.toBe(true);
    expect(native.saves).toEqual([
      [
        {
          day: DAY,
          sourceId: "src1",
          category: "files",
          bytesIn: 7,
          bytesOut: 3,
          streams: 2,
        },
      ],
    ]);
    expect(localStorage.getItem(TRAFFIC_STORAGE_KEY)).toBeNull();
    ledger.record("src1", "files", 1, 0);
    ledger.flush();
    expect(localStorage.getItem(TRAFFIC_STORAGE_KEY)).toBeNull();
    expect(ledger.source("src1", "all").totals).toMatchObject({
      bytesIn: 8,
      bytesOut: 3,
    });
  });

  it("清零写回原生；原生没答时数留在内存里，下次落地再试", async () => {
    const native = installNative([
      {
        day: DAY,
        sourceId: "src1",
        category: "api",
        bytesIn: 9,
        bytesOut: 9,
        streams: 1,
      },
      {
        day: DAY,
        sourceId: "src2",
        category: "api",
        bytesIn: 1,
        bytesOut: 1,
        streams: 1,
      },
    ]);
    const { storage, ledger } = newLedger();
    await storage.hydrate();
    ledger.clear("src1");
    expect(native.saves.at(-1)).toEqual([
      expect.objectContaining({ sourceId: "src2" }),
    ]);

    const broken = installNative("broken");
    const next = newLedger();
    await expect(next.storage.hydrate()).resolves.toBe(false);
    next.ledger.record("src1", "api", 4, 0);
    next.ledger.flush();
    expect(broken.saves).toEqual([]);
    expect(next.ledger.source("src1", "all").totals.bytesIn).toBe(4);
  });
});
