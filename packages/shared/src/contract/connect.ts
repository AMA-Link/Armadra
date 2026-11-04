import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `connect.*`（契约 §99）：「连接手机」的一张二维码。电脑端点开对话框才铸，core 自己拼
 * 好直连与中转两半；页面只显示 `uri`。只有 owner（`settings:write`），经中继的浏览器
 * 一律 `403`（与配对秘密同一条规则，§88.7）。
 *
 * 票和秘密只答给调用方，不进审计、日志与事件。
 */

export const connectOfferSchema = z.object({
  /** core 的 `hostId`。 */
  sourceId: z.string(),
  /** 二维码的截止时刻：在场各半里最早的到期。 */
  expiresAtMs: z.number().int(),
  /** 二维码文本：`<网页来源>/#c=2&…`（§99.2）。 */
  uri: z.string(),
  direct: z
    .object({
      /** 去掉回环、最多 3 个，与 Gateway 的 `origins` 同序。 */
      origins: z.array(z.string()),
      /** 信任锚 SHA-256，小写十六进制。 */
      fingerprint: z.string(),
      /** 私网档位上的 8 位配对码（`XXXX-XXXX`），公网档位是 `null`。 */
      code: z.string().nullable(),
      /** 「复制链接」：浏览器用的 `https://<来源>/#pair=…`。 */
      webUrl: z.string(),
    })
    .nullable(),
  relay: z
    .object({
      issuers: z.array(z.string()),
      identityFingerprint: z.string(),
    })
    .nullable(),
});

export type ConnectOffer = z.infer<typeof connectOfferSchema>;

export const connect = {
  /** 铸一枚 offer：两半都由 core 拼；同一时刻只活一枚，新的作废旧的。 */
  offer: oc
    .input(z.object({}).optional())
    .output(connectOfferSchema)
    .errors(errors.pick("unauthenticated", "forbidden", "connect_unavailable"))
    .meta(
      meta({
        scope: "settings:write",
        since: "1.54",
        contract: "§99.1",
      }),
    ),
};
