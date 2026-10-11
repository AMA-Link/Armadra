import * as React from "react";

import type { SourceConnection } from "./connection";
import { type SourceRegistry, sourceRegistry } from "./registry";
import type { SourceStatus } from "./types";

/**
 * 源表的 React 入口（客户端包 §1.1）。不包 `<SourcesProvider>` 时用页面那张
 * 源表（`sourceRegistry()`，只有本机源），所以现有的组件树不必改就能用这些钩子。
 */
const SourcesContext = React.createContext<SourceRegistry | null>(null);

export function SourcesProvider({
  registry,
  children,
}: {
  registry?: SourceRegistry;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => registry ?? sourceRegistry(), [registry]);
  return (
    <SourcesContext.Provider value={value}>{children}</SourcesContext.Provider>
  );
}

/** 此处生效的源表（`<SourcesProvider>` 给的，否则页面那张）。 */
export function useSourceRegistry(): SourceRegistry {
  return useRegistry();
}

function useRegistry(): SourceRegistry {
  return React.useContext(SourcesContext) ?? sourceRegistry();
}

/** 全部源（本机在前）。 */
export function useSources(): readonly SourceConnection[] {
  const registry = useRegistry();
  return React.useSyncExternalStore(registry.subscribe, registry.list);
}

/** 一个源；不在源表里是 `undefined`。 */
export function useSource(sourceId: string): SourceConnection | undefined {
  const registry = useRegistry();
  return React.useSyncExternalStore(registry.subscribe, () =>
    registry.get(sourceId),
  );
}

/** 当前源。 */
export function useCurrentSource(): SourceConnection {
  const registry = useRegistry();
  return React.useSyncExternalStore(registry.subscribe, registry.current);
}

const IDLE: SourceStatus = {
  state: "idle",
  via: null,
  since: 0,
  lastError: null,
};

/** 一个源的状态（连接中、就绪、离线……）；源不在是 `idle`。 */
export function useSourceStatus(
  connection: SourceConnection | undefined,
): SourceStatus {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      connection?.subscribe(listener) ?? (() => undefined),
    [connection],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => connection?.status ?? IDLE,
  );
}

/**
 * 一批源各自的连接状态（任一个变了就重算）：侧栏分组与工作空间查询用它，
 * 一台电脑连上、断开时跟着重画，不必等别处触发。
 */
export function useSourceStates(
  connections: readonly SourceConnection[],
): Readonly<Record<string, SourceStatus["state"]>> {
  const read = React.useCallback(
    () =>
      Object.fromEntries(
        connections.map((connection) => [
          connection.descriptor.sourceId,
          connection.status.state,
        ]),
      ),
    [connections],
  );
  const [states, setStates] = React.useState(read);
  React.useEffect(() => {
    const refresh = () =>
      setStates((previous) => {
        const next = read();
        const same =
          Object.keys(next).length === Object.keys(previous).length &&
          Object.entries(next).every(([id, state]) => previous[id] === state);
        return same ? previous : next;
      });
    refresh();
    const stops = connections.map((connection) =>
      connection.subscribe(refresh),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [connections, read]);
  return states;
}
