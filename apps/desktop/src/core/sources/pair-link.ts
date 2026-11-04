import { fail } from "../http/errors";
import { normalizeOrigin } from "./http-client";

/** `#pair=<票>&fp=<指纹>` 的网页链接（契约 §17）。 */
export function parsePairLink(link: string): {
  origin: string;
  ticket: string;
  fingerprint: string;
} {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw fail("bad_request", "配对链接不是一个合法的地址");
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const ticket = fragment.get("pair") ?? "";
  if (ticket === "") throw fail("bad_request", "配对链接里没有票");
  return {
    origin: normalizeOrigin(url.origin),
    ticket,
    fingerprint: fragment.get("fp") ?? "",
  };
}
