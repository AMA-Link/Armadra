import { parseConnect } from "@armadra/shared";

import { offerFromConnect, storagePairings } from "../sources/e2e/pairing";
import type { ConnectFailure } from "./ConnectScreen";
import { rejectionFailure } from "./connect-offer";

/**
 * 手机相机扫到连接二维码，在浏览器里打开了 `<网页来源>/#c=…`（契约 §99.5 第 6 条）。
 * 在入口决定之前把它接到浏览器里原来就有的两条路上，之后的界面不用认识新的片段：
 *
 *  - 页面就是二维码里直连半的一个来源（Gateway 自己服务的网页）：改写成 `#pair=<票>&fp=<锚>`，
 *    由原来的配对流程接手；
 *  - 否则有中转半：页面是远程服务的网页，改到 `/h/<源>`（控制台打开这台主机）。
 *
 * 有中转半时秘密记进本机存储，通道握手里带上 proof，设备直接受信。片段里有秘密，
 * 读完立刻从地址栏抹掉或改写。合规矩但走不通、过期、旧版、新版，抹掉并带回失败原因。
 */
export type ConnectFragment =
  | { readonly kind: "none" }
  | { readonly kind: "adopted" }
  | { readonly kind: "failure"; readonly failure: ConnectFailure };

const SECRET_EXTRA_MS = 3 * 60_000;

export function adoptConnectFragment(
  location: Pick<
    Location,
    "href" | "hash" | "origin" | "pathname" | "search"
  > = globalThis.location,
  history: Pick<History, "replaceState"> | undefined = globalThis.history,
  now: number = Date.now(),
): ConnectFragment {
  if (!location.hash.startsWith("#c=")) return { kind: "none" };
  const rewrite = (path: string) => {
    try {
      history?.replaceState(null, "", path);
    } catch {
      /* 改不了地址栏就只是没接上。 */
    }
  };
  const clean = `${location.pathname}${location.search}`;
  const parsed = parseConnect(location.href, now);
  if (!parsed.ok) {
    rewrite(clean);
    return { kind: "failure", failure: rejectionFailure(parsed.reason) };
  }
  const { payload } = parsed;
  if (payload.relay !== null) {
    const offer = offerFromConnect(
      payload.sourceId,
      payload.expiresAtMs + (payload.direct === null ? 0 : SECRET_EXTRA_MS),
      payload.relay,
    );
    if (offer !== null) storagePairings().remember(offer);
  }
  if (payload.direct?.origins.includes(location.origin)) {
    rewrite(
      `${location.pathname}${location.search}#pair=${payload.direct.ticket}&fp=${payload.direct.fingerprint}`,
    );
    return { kind: "adopted" };
  }
  if (payload.relay !== null) {
    rewrite(`/h/${payload.sourceId}`);
    return { kind: "adopted" };
  }
  rewrite(clean);
  return { kind: "failure", failure: "offerUnreachable" };
}
