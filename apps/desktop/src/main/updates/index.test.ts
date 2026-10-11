/**
 * 更新装配接到系统上的两处：系统通知与它的语言。托盘项的显隐规则在
 * `tray.ts::setUpdateStaged`，暂存公告的内容在 `updater.test.ts`。
 */
import { beforeEach, expect, it, vi } from "vitest";

const shown: { title: string; body: string }[] = [];
let supported = true;
let locale = "zh-CN";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.1.0",
    getAppPath: () => "/nowhere",
    getLocale: () => locale,
    quit: () => undefined,
  },
  Notification: class {
    static isSupported() {
      return supported;
    }
    constructor(private readonly options: { title: string; body: string }) {}
    show() {
      shown.push(this.options);
    }
  },
}));
vi.mock("../window", () => ({
  sendToWindow: () => undefined,
  markQuitting: () => undefined,
  getMainWindow: () => null,
}));

const { notificationLocale, showNotification } = await import("./index");

beforeEach(() => {
  shown.length = 0;
  supported = true;
  locale = "zh-CN";
});

it("shows one notification where the platform draws them, and none elsewhere", () => {
  showNotification("更新已下载", "重启 Armadra 即可更新到 0.6.1。");
  expect(shown).toEqual([
    { title: "更新已下载", body: "重启 Armadra 即可更新到 0.6.1。" },
  ]);
  supported = false;
  showNotification("x", "y");
  expect(shown).toHaveLength(1);
});

it("speaks the system UI's language", () => {
  expect(notificationLocale()).toBe("zhCn");
  locale = "en-US";
  expect(notificationLocale()).toBe("en");
});
