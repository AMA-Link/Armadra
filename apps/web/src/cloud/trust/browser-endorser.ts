import {
  coded,
  createHostChannel,
  refusalCode,
  type HostChannel,
  type HostChannelOptions,
} from "../host-channel";
import type { EndorsableRequest, HostEndorser } from "./endorser";

export { IDLE_MS, MAX_OPEN } from "../host-channel";

/**
 * 控制台的生产 `HostEndorser`（云端控制台 §3.3.9）：经 `cloud/host-channel.ts` 的端到端通道池与
 * 主机 core 说话（与「新建链接」共用同一个池），不另造信任通道。
 *
 * - `canEndorse`：通道池的 `probe`（`cloud/login` 的只判定模式，core 契约 §31.3），不惊动主人。
 * - `approve`：同一条通道里以受信设备的会话 `POST /api/devices/approve { pendingId, sas }`；
 *   放行与否由 core 的 `authorizeEndorsement` 判定（契约 §60.4）。校验码只在这个函数的参数与
 *   请求体里：错误只带码，不写日志。
 * - 通道的生命周期（空闲关闭、上限、`dispose` 与进行中操作的竞态）都在通道池里。
 */

export interface BrowserEndorserOptions extends HostChannelOptions {
  /** 共用的通道池；缺省按其余选项单独建一个。 */
  readonly channel?: HostChannel;
}

export type BrowserEndorser = HostEndorser & { dispose(): void };

export function createBrowserEndorser(
  options: BrowserEndorserOptions,
): BrowserEndorser {
  const channel = options.channel ?? createHostChannel(options);
  return {
    canEndorse(sourceId) {
      return channel.probe(sourceId);
    },

    async approve(request: EndorsableRequest, sas: string) {
      if (request.pendingId === "") throw coded("not_found");
      const response = await channel.request(
        request.sourceId,
        "/api/devices/approve",
        { method: "POST", body: { pendingId: request.pendingId, sas } },
      );
      if (!response.ok) throw coded(await refusalCode(response));
    },

    dispose() {
      channel.dispose();
    },
  };
}
