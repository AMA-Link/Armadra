import { afterEach, describe, expect, it, vi } from "vitest";

import {
  offerCloudLink,
  onCloudIntent,
  parseCloudLink,
  takeCloudIntent,
} from "./cloud-intent";

const WITH = `armadra://cloud?issuer=${encodeURIComponent("https://cloud.example.com")}`;

afterEach(() => void takeCloudIntent());

describe("armadra://cloud 深链（页面再核一遍）", () => {
  it("无参数与干净的 issuer", () => {
    expect(parseCloudLink("armadra://cloud")).toEqual({ issuer: "" });
    expect(parseCloudLink(WITH)).toEqual({
      issuer: "https://cloud.example.com",
    });
    expect(
      parseCloudLink(
        `armadra://cloud?issuer=${encodeURIComponent("http://127.0.0.1:8080")}`,
      ),
    ).toEqual({ issuer: "http://127.0.0.1:8080" });
  });

  it("非 https 的 issuer、带路径 / 账号口令 / 别的参数 / 别的深链：不认", () => {
    const issuer = (value: string) =>
      parseCloudLink(`armadra://cloud?issuer=${encodeURIComponent(value)}`);
    expect(issuer("http://cloud.example.com")).toBeNull();
    expect(issuer("https://u:p@cloud.example.com")).toBeNull();
    expect(issuer("https://cloud.example.com/x")).toBeNull();
    expect(parseCloudLink(`${WITH}&token=s`)).toBeNull();
    expect(parseCloudLink("armadra://join?link=a&issuer=b&s=c")).toBeNull();
    expect(parseCloudLink("https://cloud.example.com")).toBeNull();
    expect(parseCloudLink("not a url")).toBeNull();
  });

  it("交来即通知，取走即清；认不出的丢掉不通知", () => {
    const listener = vi.fn();
    const off = onCloudIntent(listener);
    expect(offerCloudLink("armadra://pair?x=1")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(offerCloudLink(WITH)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeCloudIntent()).toBe("https://cloud.example.com");
    expect(takeCloudIntent()).toBeNull();
    off();
    offerCloudLink("armadra://cloud");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeCloudIntent()).toBe("");
  });
});
