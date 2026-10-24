import { afterEach, describe, expect, it, vi } from "vitest";

import { csvFileName, downloadCsv, toCsv } from "./csv";

afterEach(() => vi.restoreAllMocks());

describe("CSV 本地生成", () => {
  it("引号、逗号、换行被加引号转义，空值留空，BOM 开头、CRLF 分行", () => {
    const text = toCsv(
      ["name", "note"],
      [
        ["张三", 'say "hi", ok'],
        ["line", "a\nb"],
        ["none", null],
      ],
    );
    expect(text).toBe(
      '﻿name,note\r\n张三,"say ""hi"", ok"\r\nline,"a\nb"\r\nnone,\r\n',
    );
  });

  it("以公式字符开头的值补单引号，防止被表格软件当公式执行", () => {
    const text = toCsv(["v"], [["=1+1"], ["+cmd"], ["-5"], ["@sum"], ["ok"]]);
    expect(text.split("\r\n").slice(1, 6)).toEqual([
      "'=1+1",
      "'+cmd",
      "'-5",
      "'@sum",
      "ok",
    ]);
  });

  it("文件名去掉路径与非法字符", () => {
    expect(csvFileName("build/01: gpu", "access")).toBe(
      "build-01- gpu-access.csv",
    );
    expect(csvFileName("  ", "access")).toBe("export-access.csv");
  });

  it("下载走 Blob 与临时链接，不发请求，用完释放", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:mock";
    });
    URL.revokeObjectURL = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("a.csv");
        expect(this.href).toContain("blob:mock");
      });
    downloadCsv("a.csv", "x");
    expect(click).toHaveBeenCalledOnce();
    expect(await created[0]!.text()).toBe("x");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector("a[download]")).toBeNull();
    vi.unstubAllGlobals();
  });
});
