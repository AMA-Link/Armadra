// 端到端通道的客户端一侧（中继端到端加密设计 §4、契约 §78）：页面、手机 WebView 与
// 测试共用。握手与记录层在协议包 `@armadra/platform-protocol/e2e`；这里是复用、
// `fetch` 与 `WebSocket` 的形状。设备钥的存放与通道管理在 `apps/web/src/sources/e2e/`。
export {
  type ChannelCounters,
  type DevicePlatform,
  E2eChannelError,
  type E2eChannelErrorCode,
  type E2eChannelOptions,
  E2eClientChannel,
  relayRefusal,
} from "./channel.js";
export { type ChannelFetchOptions, channelFetch, innerPath } from "./http.js";
export {
  ClientMux,
  InnerStream,
  type MuxLimits,
  RST_CODE,
  StreamReset,
} from "./mux.js";
export { type ChannelSocketOptions, channelWebSocket } from "./socket.js";
