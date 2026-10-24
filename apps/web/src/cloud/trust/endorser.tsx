import * as React from "react";

import type { CloudClient } from "../api/client";

/** 一条待信任请求（云端 `trust.list`）：没有校验码，云端不经手它。 */
export type TrustRequest = Awaited<
  ReturnType<CloudClient["trust"]["list"]>
>["requests"][number];

/**
 * 端到端背书的端口（云端控制台 §3.3.9）。校验码只由背书人输入、经端到端通道交给主机核对
 * （core 契约 §80 第 8 项），不经云端。实现由浏览器的 `browser-cloud` 凭据提供方接上：
 *
 * - `canEndorse`：尝试向这台主机打开端到端通道；本浏览器是它的受信设备才是 `true`。
 * - `approve`：把码交给主机的 `devices.approve`；失败抛带 `code` 的错误：
 *   `sas_mismatch`、`sas_expired`、`device_untrusted`、`e2e_device_unavailable`。
 *
 * 还没有实现（`null`）时每一行都按「不是受信设备」画，不渲染「信任」。
 */
export interface HostEndorser {
  canEndorse(sourceId: string): Promise<boolean>;
  approve(request: TrustRequest, sas: string): Promise<void>;
}

const EndorserContext = React.createContext<HostEndorser | null>(null);

export function EndorserProvider({
  endorser,
  children,
}: {
  endorser: HostEndorser | null;
  children: React.ReactNode;
}) {
  return (
    <EndorserContext.Provider value={endorser}>
      {children}
    </EndorserContext.Provider>
  );
}

export const useEndorser = () => React.useContext(EndorserContext);

/** 端到端通道或主机报的失败码（形状同 `CloudConsoleError`，不依赖它）。 */
export function endorseCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
