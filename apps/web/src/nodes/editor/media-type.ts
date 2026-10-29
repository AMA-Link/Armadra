import type { MediaKind } from "./types";

/**
 * 预览用的 `blob:` 的类型（设计 saas-host-open §5.4）：主机报的 MIME 只在白名单里才用，其余按
 * 媒体种类给一个不会被当成网页的类型。`blob:` 与页面同源，报成 `text/html`（或别的能执行的
 * 类型）的「图片」「PDF」一旦进了框架或被新标签打开，就在页面的来源里执行。
 */
const ALLOWED: Record<MediaKind, ReadonlySet<string>> = {
  image: new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    // 在 `<img>` 里 SVG 不执行脚本；这里只给 `<img>` 用。
    "image/svg+xml",
  ]),
  video: new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]),
  audio: new Set([
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/flac",
  ]),
  pdf: new Set(["application/pdf"]),
};

const FALLBACK: Record<MediaKind, string> = {
  // 图片与音视频靠引擎嗅探内容解码；给不了合适的类型时用二进制流，不会被当网页。
  image: "application/octet-stream",
  video: "application/octet-stream",
  audio: "application/octet-stream",
  pdf: "application/pdf",
};

export function mediaBlobType(media: MediaKind, reported: string): string {
  const type = reported.split(";")[0]!.trim().toLowerCase();
  return ALLOWED[media].has(type) ? type : FALLBACK[media];
}
