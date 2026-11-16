// 场景层的公共签名（docs/design/board-engine.md §2.4）。
import type { Entity, EntityId, KindSpec, Layer, Rect, Vec } from "../types";
import type { Patch } from "./patch";

/** 手势中可被预览改写的几何。 */
export type Geometry = Pick<Entity, "x" | "y" | "w" | "h">;

export type PreviewChanges = ReadonlyMap<EntityId, Partial<Geometry>>;

/** 层的绘制顺序，靠前的在下。 */
export const LAYER_ORDER: readonly Layer[] = [
  "canvas-under",
  "world",
  "canvas-over",
  "overlay",
];

export interface SceneOptions {
  /** 按 kind 查 `KindSpec`：决定层与精确命中。未注册的 kind 当 `world` 层、按包围盒命中。 */
  kinds?: (kind: string) => Pick<KindSpec, "layer" | "hit"> | undefined;
}

export interface Scene<D = unknown> {
  /** 文档里的实体（不含预览）；未改动的实体始终是同一个引用。 */
  get(id: EntityId): Entity<D> | undefined;
  has(id: EntityId): boolean;
  readonly size: number;
  /** 子实体，按 z 升序；`undefined` 取顶层。 */
  children(parent?: EntityId): readonly Entity<D>[];
  /** 全部实体，按层再按 z 升序（同 z 保持写入顺序）。未变化时返回同一个数组。 */
  ordered(): readonly Entity<D>[];
  /** 绝对包围盒：已叠加父级偏移与预览。连接类实体取两端包围盒的并集。 */
  bounds(id: EntityId): Rect | undefined;
  /** 包围盒与 `area` 相交（含相切）的实体。 */
  query(area: Rect, filter?: (entity: Entity<D>) => boolean): Entity<D>[];
  /** 最上面命中的实体；`tolerance` 单位同世界坐标。 */
  hit(
    point: Vec,
    options?: { tolerance?: number; layers?: readonly Layer[] },
  ): Entity<D> | undefined;
  /** 应用外部真相的一次增量；不进撤销栈。 */
  sync(patch: Patch<D>): void;
  /** 预览事务：手势中的临时几何，按 id 合并；提交（`commitPreview`）之前文档不变。 */
  preview(changes: PreviewChanges): void;
  /** 丢弃预览；不给 `ids` 就全部丢弃。 */
  clearPreview(ids?: readonly EntityId[]): void;
  previewOf(id: EntityId): Partial<Geometry> | undefined;
  /** 有没有手势（预览）在进行。 */
  gestureActive(): boolean;
  /** 批量通知：每次写入 / 预览变化只通知一次，带上受影响的 id（含随父级移动的子孙与相连的连接类实体）。 */
  subscribe(listener: (changed: ReadonlySet<EntityId>) => void): () => void;
}

/** 事务里的草稿：读到的是事务内最新值，所有改动在事务结束时一次落下。 */
export interface SceneDraft<D = unknown> {
  get(id: EntityId): Entity<D> | undefined;
  /** 新建或整体替换。 */
  set(entity: Entity<D>): void;
  /** 浅合并改写；实体不存在返回 `false`。 */
  update(id: EntityId, changes: Partial<Omit<Entity<D>, "id">>): boolean;
  remove(id: EntityId): void;
}

export interface TransactOptions {
  /** `ignore`：改动照写，但不进撤销栈（远端合并、运行期记账）。默认 `record`。 */
  history?: "record" | "ignore";
  label?: string;
}

/** 独立使用时的可写场景（展示页、测试）；Armadra 走适配器，不用它的撤销栈。 */
export interface MemoryScene<D = unknown> extends Scene<D> {
  transact(
    mutate: (draft: SceneDraft<D>) => void,
    options?: TransactOptions,
  ): Patch<D>;
  /** 应用一条补丁（写成 `after`），返回逆补丁；前后取实际的当前值，不信补丁里的 before。 */
  apply(patch: Patch<D>, options?: TransactOptions): Patch<D>;
  /** 把当前预览写进文档并清掉预览，一次手势一条历史。 */
  commitPreview(options?: TransactOptions): Patch<D>;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 合并会话：期间的 `record` 并成一条，`endCoalesce` 才入栈。 */
  beginCoalesce(label: string): void;
  endCoalesce(): void;
  /** 历史栈变化（入栈、撤销、重做、清空）。返回退订。 */
  subscribeHistory(listener: () => void): () => void;
  /** 换板时清栈。 */
  resetHistory(): void;
}
