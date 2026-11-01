import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudIssuer } from "./cloud-issuer";

afterEach(() => vi.unstubAllEnvs());

describe("网页与手机的 Armadra 云地址", () => {
  it("没有构建时变量用默认地址", () => {
    vi.stubEnv("VITE_ARMADRA_CLOUD_ISSUER", "");
    expect(cloudIssuer()).toBe("https://app.armadra.com");
  });

  it("VITE_ARMADRA_CLOUD_ISSUER 是 https（回环可 http）才覆盖，不合规忽略", () => {
    vi.stubEnv("VITE_ARMADRA_CLOUD_ISSUER", "https://cloud.example.test");
    expect(cloudIssuer()).toBe("https://cloud.example.test");
    vi.stubEnv("VITE_ARMADRA_CLOUD_ISSUER", "http://127.0.0.1:8787");
    expect(cloudIssuer()).toBe("http://127.0.0.1:8787");
    vi.stubEnv("VITE_ARMADRA_CLOUD_ISSUER", "http://cloud.example.test");
    expect(cloudIssuer()).toBe("https://app.armadra.com");
  });
});
