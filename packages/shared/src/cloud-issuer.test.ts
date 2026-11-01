import { describe, expect, it } from "vitest";

import {
  ARMADRA_CLOUD_ISSUER,
  cloudIssuerOverride,
  resolveCloudIssuer,
} from "./cloud-issuer";

describe("Armadra 云默认地址", () => {
  it("缺省是 https://app.armadra.com", () => {
    expect(ARMADRA_CLOUD_ISSUER).toBe("https://app.armadra.com");
    expect(resolveCloudIssuer()).toBe("https://app.armadra.com");
    expect(resolveCloudIssuer(undefined)).toBe("https://app.armadra.com");
    expect(resolveCloudIssuer("")).toBe("https://app.armadra.com");
    expect(resolveCloudIssuer("   ")).toBe("https://app.armadra.com");
  });

  it("覆盖值是 https 来源就用它（规范化，去掉末尾斜杠），回环允许 http", () => {
    expect(resolveCloudIssuer("https://cloud.example.test")).toBe(
      "https://cloud.example.test",
    );
    expect(resolveCloudIssuer(" https://cloud.example.test/ ")).toBe(
      "https://cloud.example.test",
    );
    expect(resolveCloudIssuer("https://127.0.0.1:8443")).toBe(
      "https://127.0.0.1:8443",
    );
    expect(resolveCloudIssuer("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(resolveCloudIssuer("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(resolveCloudIssuer("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  it("不合规的覆盖值一律忽略并用缺省：非回环 http、别的协议、带账号 / 路径 / 查询 / 片段、不是地址", () => {
    for (const bad of [
      "http://cloud.example.test",
      "http://192.168.1.5:8787",
      "ftp://cloud.example.test",
      "javascript:alert(1)",
      "https://user:pw@cloud.example.test",
      "https://cloud.example.test/path",
      "https://cloud.example.test/?a=1",
      "https://cloud.example.test/#x",
      "cloud.example.test",
      "not a url",
    ]) {
      expect(cloudIssuerOverride(bad)).toBeNull();
      expect(resolveCloudIssuer(bad)).toBe(ARMADRA_CLOUD_ISSUER);
    }
  });
});
