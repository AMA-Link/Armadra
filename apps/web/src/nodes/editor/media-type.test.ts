import { describe, expect, it } from "vitest";

import { mediaBlobType } from "./media-type";

describe("预览 blob: 的类型按白名单", () => {
  it("白名单里的照用（去掉参数、大小写不论）", () => {
    expect(mediaBlobType("image", "IMAGE/PNG")).toBe("image/png");
    expect(mediaBlobType("audio", "audio/mpeg; codecs=mp3")).toBe("audio/mpeg");
    expect(mediaBlobType("video", "video/mp4")).toBe("video/mp4");
  });

  it("主机报成能执行的类型：一律换成不会被当网页的类型", () => {
    for (const reported of [
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml;x",
      "text/xml",
    ]) {
      expect(mediaBlobType("video", reported)).toBe("application/octet-stream");
      expect(mediaBlobType("pdf", reported)).toBe("application/pdf");
    }
    expect(mediaBlobType("image", "text/html")).toBe(
      "application/octet-stream",
    );
    // 媒体种类对不上的也不用（图片报成视频类型）。
    expect(mediaBlobType("image", "video/mp4")).toBe(
      "application/octet-stream",
    );
  });
});
