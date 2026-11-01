import { describe, expect, it } from "vitest";
import {
  acceptsConnection,
  addressPriority,
  bindHost,
  certificateHosts,
  gatewayHosts,
  interfaceAddresses,
  machineHostname,
  originsFor,
  prioritizeAddresses,
  privateAddress,
  privateAddresses,
} from "./network";

const INTERFACES = {
  lo0: [
    { address: "127.0.0.1", internal: true },
    { address: "::1", internal: true },
  ],
  en0: [
    { address: "192.168.1.20", internal: false },
    { address: "fe80::1", internal: false },
    { address: "fd12::5", internal: false },
  ],
  en1: [
    { address: "169.254.3.3", internal: false },
    { address: "203.0.113.9", internal: false },
  ],
  utun3: [{ address: "100.101.102.103", internal: false }],
} as unknown as Parameters<typeof privateAddresses>[0];

describe("Gateway 的地址", () => {
  it("私网：RFC 1918、CGNAT、ULA；公网、回环、链路本地都不算", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1",
      "fd00::1",
      "::ffff:192.168.1.2",
    ]) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of [
      "172.32.0.1",
      "8.8.8.8",
      "127.0.0.1",
      "169.254.1.1",
      "fe80::1",
      "2001:db8::1",
    ]) {
      expect(privateAddress(address), address).toBe(false);
    }
  });

  it("网卡枚举：私网一档与全部一档", () => {
    expect(privateAddresses(INTERFACES)).toEqual([
      "100.101.102.103",
      "192.168.1.20",
      "fd12::5",
    ]);
    expect(interfaceAddresses(INTERFACES)).toEqual([
      "100.101.102.103",
      "192.168.1.20",
      "203.0.113.9",
      "fd12::5",
    ]);
  });

  it("绑定与按本地地址筛连接", () => {
    expect(bindHost("loopback")).toBe("127.0.0.1");
    expect(bindHost("private")).toBe("0.0.0.0");
    expect(bindHost("all")).toBe("0.0.0.0");
    const privates = ["192.168.1.20"];
    expect(acceptsConnection("private", "192.168.1.20", privates)).toBe(true);
    expect(acceptsConnection("private", "::ffff:192.168.1.20", privates)).toBe(
      true,
    );
    expect(acceptsConnection("private", "127.0.0.1", privates)).toBe(true);
    expect(acceptsConnection("private", "203.0.113.9", privates)).toBe(false);
    expect(acceptsConnection("private", undefined, privates)).toBe(false);
    expect(acceptsConnection("all", "203.0.113.9", privates)).toBe(true);
  });

  it("自己的主机：私网在前、主机名其次、回环最后；localhost 永远不在", () => {
    const addresses = {
      privates: ["192.168.1.20"],
      all: ["192.168.1.20", "203.0.113.9"],
    };
    expect(gatewayHosts("loopback", addresses, "mac.local")).toEqual([
      "127.0.0.1",
    ]);
    expect(gatewayHosts("private", addresses, "mac.local")).toEqual([
      "192.168.1.20",
      "mac.local",
      "127.0.0.1",
    ]);
    expect(gatewayHosts("all", addresses, "")).toEqual([
      "192.168.1.20",
      "203.0.113.9",
      "127.0.0.1",
    ]);
    expect(machineHostname("localhost")).toBeUndefined();
    expect(machineHostname("Yo-MacBook.local")).toBe("yo-macbook.local");
    expect(machineHostname("bad host")).toBeUndefined();
  });

  it("二维码缺省的优先顺序：RFC 1918 → CGNAT → ULA → 其他", () => {
    const cases: Array<[string, readonly string[], readonly string[]]> = [
      [
        "192.168 与 100.x 同在：192.168 在前",
        ["100.67.25.43", "192.168.1.20"],
        ["192.168.1.20", "100.67.25.43"],
      ],
      [
        "RFC 1918 三段：192.168、10、172.16",
        ["172.16.0.5", "10.0.0.9", "192.168.0.2"],
        ["192.168.0.2", "10.0.0.9", "172.16.0.5"],
      ],
      [
        "全部种类混在一起",
        ["203.0.113.9", "fd12::5", "100.64.0.1", "172.31.0.1", "10.1.1.1"],
        ["10.1.1.1", "172.31.0.1", "100.64.0.1", "fd12::5", "203.0.113.9"],
      ],
      [
        "只有 CGNAT 与 ULA",
        ["fd00::1", "100.101.1.1"],
        ["100.101.1.1", "fd00::1"],
      ],
      [
        "同级按字面量，与枚举顺序无关",
        ["10.0.0.2", "10.0.0.1"],
        ["10.0.0.1", "10.0.0.2"],
      ],
      ["没有地址", [], []],
    ];
    for (const [name, input, expected] of cases) {
      expect(prioritizeAddresses(input), name).toEqual(expected);
    }
    expect(addressPriority("::ffff:192.168.1.2")).toBe(0);
    expect(addressPriority("172.32.0.1")).toBe(5);
    expect(addressPriority("100.128.0.1")).toBe(5);
  });

  it("gatewayHosts：二维码缺省是 192.168，不是 Tailscale 的 100.x", () => {
    // 与 `privateAddresses()` 同一个集合（字符串排序下 100.x 在前）。
    const sorted = privateAddresses(INTERFACES);
    expect(sorted[0]).toBe("100.101.102.103");
    const addresses = { privates: sorted, all: sorted };
    expect(gatewayHosts("private", addresses, "mac.local")).toEqual([
      "192.168.1.20",
      "100.101.102.103",
      "fd12::5",
      "mac.local",
      "127.0.0.1",
    ]);
    expect(
      gatewayHosts(
        "private",
        { privates: ["172.20.0.3", "10.2.2.2"], all: [] },
        "",
      ),
    ).toEqual(["10.2.2.2", "172.20.0.3", "127.0.0.1"]);
    // 没有私网地址：只剩主机名与回环。
    expect(
      gatewayHosts("private", { privates: [], all: [] }, "mac.local"),
    ).toEqual(["mac.local", "127.0.0.1"]);
    expect(gatewayHosts("private", { privates: [], all: [] }, "")).toEqual([
      "127.0.0.1",
    ]);
    // 集合不变：证书名字与「地址变没变」不受顺序影响。
    const rotated = gatewayHosts(
      "private",
      { privates: [...sorted].reverse(), all: [] },
      "mac.local",
    );
    expect([...rotated].sort()).toEqual(
      [...gatewayHosts("private", addresses, "mac.local")].sort(),
    );
  });

  it("来源与证书名字", () => {
    expect(
      originsFor(["192.168.1.20", "fd12::5"], 8443, [
        "https://armadra.example",
      ]),
    ).toEqual([
      "https://armadra.example",
      "https://192.168.1.20:8443",
      "https://[fd12::5]:8443",
    ]);
    expect(
      certificateHosts(["0.0.0.0", "127.0.0.1"], ["https://[::1]:9443"]),
    ).toEqual(["::1", "127.0.0.1"]);
  });
});
