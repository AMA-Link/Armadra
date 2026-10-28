import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * 同一份产物挂在 SaaS 控制面的 HTTPS 来源上（#580）：页面装载时按协议先当成
 * 服务器壳；入口认出是控制台、调 `markControlPlanePage` 之后，本机源不再走
 * Cookie 会话与 CSRF，`RUNTIME_VIA_SERVER_SHELL` 随之为假。
 */
const PAGE = "https://app.saas.example/login";
vi.stubGlobal("window", {
  location: { href: PAGE, origin: "https://app.saas.example" },
});

const request = await import("./request");
const { localRuntime, resetLocalRuntime } = await import("./local-runtime");
const { isServerShellServed, setControlPlanePage } = await import(
  "./runtime-url"
);

afterAll(() => {
  setControlPlanePage(false);
  resetLocalRuntime();
  vi.unstubAllGlobals();
});

describe("控制面托管的 HTTPS 页面", () => {
  it("认出控制台之前按服务器壳算，之后不再算", () => {
    expect(request.RUNTIME_VIA_SERVER_SHELL).toBe(true);
    expect(localRuntime().viaServerShell).toBe(true);

    request.markControlPlanePage();

    expect(request.RUNTIME_VIA_SERVER_SHELL).toBe(false);
    expect(localRuntime().viaServerShell).toBe(false);
    expect(isServerShellServed(undefined, PAGE)).toBe(false);
    // 地址仍是同源：控制台里加入的画布走远程源，本机源只是不再当成服务器壳。
    expect(localRuntime().httpBase).toBe("https://app.saas.example");
  });
});
