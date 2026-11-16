// 门面：把场景、相机、渲染、输入路由与种类表装成一个 Board（设计 §2.2）。
import { createMemoryScene, type CameraState, type EntityId } from "../core";
import { createCamera } from "./camera";
import {
  createSelectTool,
  type GestureDeps,
  type GestureFeedback,
} from "./gestures";
import { drawFeedback } from "./feedback";
import {
  createInputRouter,
  type BoardSelectors,
  type InputRouter,
} from "./input";
import { rasterize, browserRasterEnv } from "./raster";
import { createRenderer, type Renderer } from "./render";
import type {
  Board,
  BoardEvents,
  BoardOptions,
  DomKindSpec,
  Modifiers,
  Tool,
} from "./types";

export const DEFAULT_BOARD_OPTIONS: BoardOptions = {
  grid: 0,
  marqueeContain: false,
  inputDevice: "mouse",
  readOnly: false,
  dots: true,
  dragThreshold: 4,
  theme: "light",
};

export interface CreateBoardOptions<D> extends Partial<BoardOptions> {
  kinds?: Record<string, DomKindSpec<D>>;
  camera?: CameraState;
  tool?: Tool;
  /** 颜色名 → CSS 颜色（点阵色叫 `dot`）；绘制与导出共用。 */
  color?(name: string): string;
  /** 应用补充的可编辑区 / 自滚区选择器（沿用节点体已有的类名约定）。 */
  selectors?: BoardSelectors;
  /** 应用自己弹右键菜单：引擎只发事件，不拦原生 contextmenu。 */
  nativeContextMenu?: boolean;
}

/** 叠加层插槽：React 绑定往里 createPortal。 */
export interface BoardSlots {
  worldSvg: SVGSVGElement;
  worldHtml: HTMLElement;
  screen: HTMLElement;
}

/** 门面多暴露两项：应用自定义工具的手势依赖（选项、种类表、反馈）与叠加层插槽。 */
export type DomBoard<D = unknown> = Board<D> & {
  readonly gestureDeps: GestureDeps;
  /** 挂载后的叠加层插槽；没挂载为 null。 */
  slots(): BoardSlots | null;
};

export function createBoard<D = unknown>(
  init: CreateBoardOptions<D> = {},
): DomBoard<D> {
  const {
    kinds: initial,
    camera: start,
    tool: first,
    color,
    selectors,
    nativeContextMenu,
    ...rest
  } = init;
  const kinds = new Map(Object.entries(initial ?? {}));
  const kind = (name: string) => kinds.get(name) as DomKindSpec | undefined;
  const scene = createMemoryScene<D>({ kinds: (name) => kinds.get(name) });
  const camera = createCamera(start);
  let options: BoardOptions = { ...DEFAULT_BOARD_OPTIONS, ...rest };
  let mods = Object.fromEntries(
    ["shift", "alt", "meta", "ctrl", "space"].map((k) => [k, false]),
  ) as unknown as Modifiers;
  let selection: ReadonlySet<EntityId> = new Set();
  let active = false;
  let mounted: {
    container: HTMLElement;
    renderer: Renderer;
    router: InputRouter;
    draft: SVGElement | null;
    stopHosts: () => void;
  } | null = null;
  const listeners = new Map<string, Set<(payload: never) => void>>();

  const gestureDeps = {
    options: () => options,
    kind,
    feedback: (fb: GestureFeedback | null) => showFeedback(fb),
  };
  let tool = first ?? createSelectTool(gestureDeps);

  const showFeedback = (fb: GestureFeedback | null): void => {
    if (!mounted) return;
    mounted.draft?.remove();
    mounted.draft = fb
      ? drawFeedback(mounted.renderer.layers.worldSvg, fb, scene, camera)
      : null;
  };

  const unmount = (): void => {
    if (!mounted) return;
    const { router, renderer, container, stopHosts } = mounted;
    showFeedback(null);
    stopHosts();
    router.destroy();
    renderer.destroy();
    container.style.cursor = "";
    mounted = null;
    active = false;
  };
  const stopCamera = camera.subscribe((state) => board.emit("camera", state));

  const board: DomBoard<D> = {
    camera,
    scene,
    gestureDeps,
    slots() {
      const layers = mounted?.renderer.layers;
      return layers
        ? {
            worldSvg: layers.worldSvg,
            worldHtml: layers.worldHtml,
            screen: layers.screenSlot,
          }
        : null;
    },
    mount(container) {
      unmount();
      const renderer = createRenderer(container, {
        scene,
        camera,
        kind,
        settings: {
          theme: options.theme,
          dots: options.dots,
          selected: (id) => selection.has(id),
          ...(color && { color }),
        },
      });
      const router = createInputRouter(container, {
        board: board as unknown as Board,
        tool: () => tool,
        modifiers: () => mods,
        inputDevice: () => options.inputDevice,
        hitCanvas: (world) => {
          const e = scene.hit(world, {
            tolerance: 4 / camera.get().zoom,
            layers: ["canvas-under", "canvas-over"],
          });
          return e ? { type: "entity", id: e.id, part: "body" } : null;
        },
        gestureDeps,
        ...(selectors && { selectors }),
        ...(nativeContextMenu && { nativeContextMenu }),
      });
      const stopHosts = renderer.hosts.subscribe((c) =>
        board.emit("hosts", {
          added: [...c.added],
          removed: [...c.removed],
        }),
      );
      mounted = { container, renderer, router, draft: null, stopHosts };
      container.style.cursor = tool.cursor ?? "";
    },
    destroy() {
      unmount();
      stopCamera();
      listeners.clear();
    },
    registerKind(name, spec) {
      kinds.set(name, spec);
      mounted?.renderer.painter.invalidate();
    },
    setTool(next) {
      mounted?.router.cancel();
      tool = next;
      if (mounted) mounted.container.style.cursor = next.cursor ?? "";
    },
    setOptions(next) {
      options = { ...options, ...next };
      mounted?.renderer.painter.configure({
        theme: options.theme,
        dots: options.dots,
      });
    },
    setModifiers(next) {
      mods = { ...mods, ...next };
    },
    selection: () => selection,
    setSelection(ids) {
      selection = new Set(ids);
      mounted?.renderer.painter.invalidate();
      board.emit("selection", { ids: [...selection] });
    },
    gestureActive: () => active,
    hostOf: (id) => mounted?.renderer.hosts.hostOf(id),
    rasterize: (ids, opts = {}) =>
      rasterize(
        scene,
        kind,
        ids,
        opts,
        browserRasterEnv({ theme: options.theme, color }),
      ),
    emit(event, payload) {
      if (event === "gesture") active = (payload as { active: boolean }).active;
      if (event === "select") {
        board.setSelection(new Set((payload as { ids: EntityId[] }).ids));
      }
      for (const fn of [...(listeners.get(event) ?? [])]) {
        (fn as (p: typeof payload) => void)(payload);
      }
    },
    on<E extends keyof BoardEvents>(
      event: E,
      listener: (payload: BoardEvents[E]) => void,
    ) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(listener as (payload: never) => void);
      return () => void set.delete(listener as (payload: never) => void);
    },
  };
  return board;
}
