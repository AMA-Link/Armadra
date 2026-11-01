import { describe, expect, it } from "vitest";

import type { RemoteService } from "../../../../api/remote-services";
import { canShare, canStartRoute, planRoute } from "./hooks";

const base: RemoteService = {
  serviceId: "svc",
  kind: "personal",
  issuer: "https://relay.test",
  label: "relay.test",
  defaultLabel: "relay.test",
  accountHint: "ada",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: false,
  hasCredentials: true,
  guest: false,
};

describe("canShare / canStartRoute（契约 §88.4）", () => {
  it("个人中转：登录着、有账号名；访客与没登录的不行", () => {
    expect(canShare(base)).toBe(true);
    expect(canStartRoute(base)).toBe(true);
    expect(canShare({ ...base, guest: true })).toBe(false);
    expect(canShare({ ...base, hasCredentials: false })).toBe(false);
    expect(canShare({ ...base, accountHint: "" })).toBe(false);
  });

  it("Armadra 云：本机已登记且登录着才能分享；路线不从这里一键开", () => {
    const saas = { ...base, kind: "saas" as const, accountHint: "" };
    expect(canShare(saas)).toBe(false);
    expect(canShare({ ...saas, registered: true })).toBe(true);
    expect(canShare({ ...saas, registered: true, hasCredentials: false })).toBe(
      false,
    );
    expect(canStartRoute({ ...saas, registered: true })).toBe(false);
  });
});

describe("planRoute：「局域网 + 互联网」以 Armadra 云为缺省（#675）", () => {
  const cloud: RemoteService = {
    ...base,
    serviceId: "cloud",
    kind: "saas",
    issuer: "https://cloud.test",
    label: "cloud.test",
    accountHint: "",
  };
  const cases: Array<[string, RemoteService[], unknown]> = [
    [
      "什么账号都没有：登录 Armadra 云（缺省地址）",
      [],
      { kind: "signIn", issuer: "" },
    ],
    [
      "登出了的云：重新登录那一行的地址",
      [{ ...cloud, hasCredentials: false }],
      { kind: "signIn", issuer: "https://cloud.test" },
    ],
    [
      "已登记到云：路线已经开着",
      [{ ...cloud, registered: true }],
      { kind: "ready" },
    ],
    [
      "登录着、没登记的云：登记到空间",
      [cloud],
      { kind: "register", remote: cloud },
    ],
    ["只有个人中转：一键开", [base], { kind: "start", remote: base }],
    [
      "云与个人中转都能用：优先云",
      [base, cloud],
      { kind: "register", remote: cloud },
    ],
    [
      "云已登记、还有个人中转：云",
      [base, { ...cloud, registered: true }],
      { kind: "ready" },
    ],
    [
      "云登出了、有个人中转：个人中转照旧一键开",
      [base, { ...cloud, hasCredentials: false }],
      { kind: "start", remote: base },
    ],
    [
      "个人中转没登录、云登出：登录云",
      [
        { ...base, hasCredentials: false },
        { ...cloud, hasCredentials: false },
      ],
      { kind: "signIn", issuer: "https://cloud.test" },
    ],
    [
      "访客行不算",
      [
        { ...cloud, guest: true },
        { ...base, guest: true },
      ],
      { kind: "signIn", issuer: "" },
    ],
  ];
  for (const [name, remotes, expected] of cases) {
    it(name, () => {
      expect(planRoute(remotes)).toEqual(expected);
    });
  }
});
