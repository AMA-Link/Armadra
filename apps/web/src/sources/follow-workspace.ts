import { useCanvasStore } from "../store/canvas-store";
import { type SourceRegistry, selectCurrentSource } from "./registry";

/**
 * 当前源跟着打开的工作空间走：`canvas-store.sourceId` 是唯一的来源，这里是
 * 唯一的订阅者，把它镜像进源表。打开别的电脑上的工作空间就换到那台；关掉
 * 工作空间（`setWorkspace(null)`）回到本机。
 *
 * 工作空间所在的源还没进源表（启动时先恢复了上次的工作空间、源表随后才到）
 * 时先落在本机，源一到就跟过去；源被移走时源表自己退回本机。
 */
export function followWorkspaceSource(registry: SourceRegistry): () => void {
  const apply = () => {
    const wanted = useCanvasStore.getState().sourceId;
    if (registry.current().descriptor.sourceId === wanted) return;
    if (
      registry.get(wanted) === undefined &&
      registry.current().descriptor.kind === "local"
    )
      return;
    selectCurrentSource(registry, wanted);
  };
  const stopStore = useCanvasStore.subscribe((state, previous) => {
    if (state.sourceId !== previous.sourceId) apply();
  });
  const stopRegistry = registry.subscribe(apply);
  apply();
  return () => {
    stopStore();
    stopRegistry();
  };
}
