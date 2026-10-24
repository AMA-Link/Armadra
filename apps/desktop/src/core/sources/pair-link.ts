import { fail } from "../http/errors";
import { normalizeOrigin } from "./http-client";

/** `#pair=<票>&fp=<指纹>` 的网页链接，或 `armadra://pair?host=…&ticket=…&fp=…`。 */
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
  if (url.protocol === "armadra:") {
    const host = url.searchParams.get("host") ?? "";
    const ticket = url.searchParams.get("ticket") ?? "";
    if (host === "" || ticket === "") {
      throw fail("bad_request", "配对链接缺少地址或票");
    }
    return {
      origin: normalizeOrigin(`https://${host}`),
      ticket,
      fingerprint: url.searchParams.get("fp") ?? "",
    };
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
