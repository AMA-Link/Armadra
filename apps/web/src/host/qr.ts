import { correction, generate } from "lean-qr";

/**
 * 二维码的矩阵与浏览器配对链接的解析。
 *
 * 以前这里自己实现了一个只到版本 6（L 级 134 字节）的编码器，够装一个
 * `https://192.168.1.20:8443`；Gateway 的配对链接还要带一张票和 64 位的
 * 信任锚指纹（契约 §17.3），放不下。编码交给 `lean-qr`（MIT、无依赖、
 * 支持到版本 40），这里只管两件事：编出一张 SVG 用的路径，以及浏览器配对链接
 * 的解析。
 */

export interface QrCode {
  size: number;
  /** `true` 是深色模块。索引是 `[row][col]`。 */
  modules: boolean[][];
}

/**
 * 把一段文本编成 QR 矩阵；空串或装不下时返回 `null`——宁可只显示那行地址，
 * 也不画一张扫不出来的图。纠错至少 M 级：屏幕反光与手机对焦都会丢模块。
 */
export function encodeQr(text: string): QrCode | null {
  if (text === "") return null;
  let bitmap: ReturnType<typeof generate>;
  try {
    bitmap = generate(text, { minCorrectionLevel: correction.M });
  } catch {
    return null;
  }
  const modules = Array.from({ length: bitmap.size }, (_, y) =>
    Array.from({ length: bitmap.size }, (_, x) => bitmap.get(x, y)),
  );
  return { size: bitmap.size, modules };
}

/**
 * 深色模块合并成一条 SVG path。整块图只有一个 `<path>`，不是几百个 `<rect>`。
 */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    let run = 0;
    for (let x = 0; x <= code.size; x += 1) {
      const dark = x < code.size && code.modules[y]![x]!;
      if (dark) run += 1;
      else if (run > 0) {
        parts.push(`M${x - run} ${y}h${run}v1h-${run}z`);
        run = 0;
      }
    }
  }
  return parts.join("");
}

/** 从二维码里读出来的配对信息。 */
export interface ScannedPairing {
  /** `https://<host>:<port>`。 */
  origin: string;
  ticket: string;
  /** 信任锚指纹，64 位小写十六进制；网页链接里可以没有。 */
  fingerprint: string;
}

/**
 * 反过来：扫到的文本 → 配对信息。只认浏览器用的网页链接（契约 §17）：
 * `https://<host>:<port>/#pair=<票>[&fp=<指纹>]`。「连接手机」的二维码是 `#c=` 的另一种
 * 形状，见 `@armadra/shared` 的 `parseConnect`（契约 §99）；旧的 `armadra://pair` 深链
 * 不再认。其余一律 `null`，不猜。
 */
export function parsePairingQr(text: string): ScannedPairing | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const match = /^#pair=([A-Za-z0-9._~-]+)(?:&fp=([0-9a-f]{64}))?$/.exec(
    url.hash,
  );
  if (!match || (url.pathname !== "/" && url.pathname !== "")) return null;
  return {
    origin: url.origin,
    ticket: match[1]!,
    fingerprint: match[2] ?? "",
  };
}
