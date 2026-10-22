import * as React from "react";

import type { CloudApi } from "./session";

const CloudApiContext = React.createContext<CloudApi | null>(null);

/** 控制台的客户端束（真实的，或展示页与测试里的 mock）。 */
export function CloudApiProvider({
  api,
  children,
}: {
  api: CloudApi;
  children: React.ReactNode;
}) {
  return (
    <CloudApiContext.Provider value={api}>{children}</CloudApiContext.Provider>
  );
}

export function useCloudApi(): CloudApi {
  const api = React.useContext(CloudApiContext);
  if (api === null)
    throw new Error("useCloudApi must be used inside CloudApiProvider");
  return api;
}

/** 运营会话是否在；运营登录 / 到期时重渲染。 */
export function useOperatorActive(): boolean {
  const { operator } = useCloudApi();
  return React.useSyncExternalStore(operator.subscribe, operator.active);
}
