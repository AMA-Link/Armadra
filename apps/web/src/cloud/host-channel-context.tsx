import * as React from "react";

import type { HostChannel } from "./host-channel";

/**
 * 控制台的端到端通道池（`host-channel.ts`）：`ConsoleRoot` 建一份，背书器与「新建链接」共用。
 * 没有（`null`，展示页与多数测试）时「新建链接」不渲染。
 */
const HostChannelContext = React.createContext<HostChannel | null>(null);

export function HostChannelProvider({
  channel,
  children,
}: {
  channel: HostChannel | null;
  children: React.ReactNode;
}) {
  return (
    <HostChannelContext.Provider value={channel}>
      {children}
    </HostChannelContext.Provider>
  );
}

export const useHostChannel = () => React.useContext(HostChannelContext);
