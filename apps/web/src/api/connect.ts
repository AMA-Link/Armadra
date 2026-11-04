import { connectOfferSchema } from "@armadra/shared";

import { currentClient } from "./client";

/**
 * 「连接手机」（契约 §99）：点开对话框才铸一枚二维码，核心一次拼好直连与中转两半。
 * 只有 owner；两条路都没开时核心答 409 `connect_unavailable`。
 */
export const connectApi = {
  offer: async () =>
    connectOfferSchema.parse(await currentClient().connect.offer()),
};
