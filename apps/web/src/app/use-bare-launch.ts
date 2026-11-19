import * as React from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { bareLaunchOf } from "@armadra/shared";

/**
 * 这家 Agent 是否零注入启动（`agents.<id>.bareLaunch`，契约 §113，#975）。
 *
 * 读的是应用早已在拉的那份设置（`["settings"]`，语言与布局镜像共用）：这里
 * 不发请求，只订阅它的缓存；没读到、成员读不了（403）或没有查询客户端都按「关」。
 */
export function useBareLaunch(agentId: string | undefined): boolean {
  const client = React.useContext(QueryClientContext);
  const subscribe = React.useCallback(
    (notify: () => void) =>
      client === undefined
        ? () => undefined
        : client.getQueryCache().subscribe(notify),
    [client],
  );
  const snapshot = React.useCallback(
    () =>
      agentId !== undefined &&
      bareLaunchOf(client?.getQueryData(["settings"]), agentId),
    [client, agentId],
  );
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}
