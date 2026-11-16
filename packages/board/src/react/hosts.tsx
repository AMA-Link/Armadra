// 世界层宿主：只在实体出现 / 消失时增删 portal，位置尺寸由引擎写宿主 style。
import * as React from "react";
import { createPortal } from "react-dom";
import type { Entity, EntityId } from "../core";
import type { DomBoard } from "../dom";
import { useBoard, useEntity } from "./context";

/** 有宿主的实体 id：已有的保持原顺序，新来的追加在后；订阅在外部存储的 subscribe 里接，严格模式安全。 */
function hostList(board: DomBoard) {
  const refresh = (prev: readonly EntityId[]): readonly EntityId[] => {
    const kept = prev.filter((id) => board.hostOf(id));
    const seen = new Set(kept);
    const fresh = board.scene
      .ordered()
      .filter((e) => board.hostOf(e.id) && !seen.has(e.id))
      .map((e) => e.id);
    return [...kept, ...fresh];
  };
  let ids = refresh([]);
  return {
    get: () => ids,
    subscribe(notify: () => void) {
      const off = board.on("hosts", () => {
        ids = refresh(ids);
        notify();
      });
      // 渲染与订阅之间可能已有变化：补一次对账。
      const now = refresh(ids);
      if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) {
        ids = now;
        notify();
      }
      return off;
    },
  };
}

export interface EntityHostsProps<D = unknown> {
  render(entity: Entity<D>): React.ReactNode;
  /** 只渲染一部分种类（缺省全部有宿主的实体）。 */
  filter?(entity: Entity<D>): boolean;
}

function Slot<D>({
  id,
  host,
  render,
  filter,
}: { id: EntityId; host: HTMLElement } & EntityHostsProps<D>) {
  const entity = useEntity<D>(id);
  if (!entity || (filter && !filter(entity))) return null;
  return createPortal(render(entity), host, id);
}

export function EntityHosts<D = unknown>(props: EntityHostsProps<D>) {
  const board = useBoard<D>();
  const list = React.useMemo(() => hostList(board as DomBoard), [board]);
  const ids = React.useSyncExternalStore(list.subscribe, list.get, list.get);
  return ids.map((id) => {
    const host = board.hostOf(id);
    return host ? <Slot key={id} id={id} host={host} {...props} /> : null;
  });
}
