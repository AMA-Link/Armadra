import { describe, expect, it } from "vitest";

import {
  CLOUD_LINK_MAX,
  PendingCloudLink,
  cloudLinkFromArgv,
  deepCloudLink,
} from "./cloud-link";

const WITH = `armadra://cloud?issuer=${encodeURIComponent("https://cloud.example.com")}`;

describe("回到 Armadra 云的深链", () => {
  it("认 armadra://cloud，可带干净的 issuer", () => {
    expect(deepCloudLink("armadra://cloud")).toBe("armadra://cloud");
    expect(deepCloudLink("armadra://cloud/")).toBe("armadra://cloud");
    expect(deepCloudLink(WITH)).toBe(WITH);
    // 规范化成来源：多余的斜杠与默认端口被去掉。
    expect(
      deepCloudLink(
        `armadra://cloud?issuer=${encodeURIComponent("https://cloud.example.com:443/")}`,
      ),
    ).toBe(WITH);
  });

  it("issuer 只收 https 来源，回环才允许 http", () => {
    const issuer = (value: string) =>
      deepCloudLink(`armadra://cloud?issuer=${encodeURIComponent(value)}`);
    expect(issuer("http://cloud.example.com")).toBeNull();
    expect(issuer("ftp://cloud.example.com")).toBeNull();
    expect(issuer("javascript:alert(1)")).toBeNull();
    expect(issuer("http://127.0.0.1:8080")).toBe(
      `armadra://cloud?issuer=${encodeURIComponent("http://127.0.0.1:8080")}`,
    );
    expect(issuer("http://localhost:8080")).not.toBeNull();
  });

  it("带账号口令、路径、查询、片段，或别的参数、超长：整条不认", () => {
    const issuer = (value: string) =>
      deepCloudLink(`armadra://cloud?issuer=${encodeURIComponent(value)}`);
    expect(issuer("https://u:p@cloud.example.com")).toBeNull();
    expect(issuer("https://cloud.example.com/path")).toBeNull();
    expect(issuer("https://cloud.example.com/?x=1")).toBeNull();
    expect(issuer("https://cloud.example.com/#f")).toBeNull();
    expect(deepCloudLink(`${WITH}&token=secret`)).toBeNull();
    expect(deepCloudLink("armadra://cloud?s=abc")).toBeNull();
    expect(deepCloudLink(`${WITH}#frag`)).toBeNull();
    expect(deepCloudLink("armadra://cloud/extra")).toBeNull();
    expect(deepCloudLink(`${WITH}${"x".repeat(CLOUD_LINK_MAX)}`)).toBeNull();
  });

  it("别的深链与非字符串不认", () => {
    expect(deepCloudLink("armadra://join?link=a&issuer=b&s=c")).toBeNull();
    expect(deepCloudLink("armadra://cloudy")).toBeNull();
    expect(deepCloudLink("armadra://pair?host=h")).toBeNull();
    expect(deepCloudLink("https://cloud.example.com")).toBeNull();
    expect(deepCloudLink(42)).toBeNull();
    expect(deepCloudLink(undefined)).toBeNull();
  });

  it("启动参数里取最后一条认得出的", () => {
    expect(cloudLinkFromArgv(["/Applications/Armadra", "--flag"])).toBeNull();
    expect(
      cloudLinkFromArgv([
        "armadra",
        "armadra://cloud",
        "armadra://pair?x=1",
        WITH,
      ]),
    ).toBe(WITH);
  });

  it("待转交：只留最新一条，取走即清", () => {
    const pending = new PendingCloudLink(null);
    expect(pending.offer("armadra://other")).toBe(false);
    expect(pending.offer(WITH)).toBe(true);
    expect(pending.offer("armadra://cloud")).toBe(true);
    expect(pending.take()).toBe("armadra://cloud");
    expect(pending.take()).toBeNull();
  });
});
