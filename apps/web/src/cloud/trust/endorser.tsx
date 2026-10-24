import * as React from "react";

import type { CloudClient } from "../api/client";

/** 一条待信任请求（云端 `trust.list`）：没有校验码，云端不经手它。 */
export type TrustRequest = Awaited<
  ReturnType<CloudClient["trust"]["list"]>
>["requests"][number];

/** 主机 core 上这条待确认设备的号（`devices.approve` 的 `pendingId`），与云端的 `trq_` 请求号不是一回事。 */
export type EndorsableRequest = TrustRequest & { readonly pendingId: string };

/**
 * 请求带的 core `pendingId`；没有（未知）是 `undefined`。现契约（协议 0.10.0）的 `trustRequest` 不带它，
 * 待云端补字段（armadra-cloud 跟进）；补上之前所有请求都不可背书，页面只给「在已信任的设备上处理」。
 */
export function pendingIdOf(request: TrustRequest): string | undefined {
  const value = (request as { pendingId?: unknown }).pendingId;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 端到端背书的端口（云端控制台 §3.3.9）。校验码只由背书人输入、经端到端通道交给主机核对
 * （core 契约 §80 第 8 项），不经云端。实现由浏览器的 `browser-cloud` 凭据提供方接上：
 *
 * - `canEndorse`：尝试向这台主机打开端到端通道；本浏览器是它的受信设备才是 `true`。
 * - `approve`：把码连同 core 的 `pendingId` 交给主机的 `devices.approve`；失败抛带 `code` 的错误：
 *   `sas_mismatch`、`sas_expired`、`device_untrusted`、`forbidden`、`e2e_device_unavailable`。
 *
 * 没有实现（`null`）或请求不带 `pendingId` 时，这一行按「不可背书」画，不渲染「信任」。
 */
export interface HostEndorser {
  canEndorse(sourceId: string): Promise<boolean>;
  approve(request: EndorsableRequest, sas: string): Promise<void>;
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
