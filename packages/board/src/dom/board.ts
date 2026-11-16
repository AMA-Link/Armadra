// 门面：把场景、相机、渲染、输入路由与种类表装成一个 Board（设计 §2.2）。
import { createMemoryScene, type CameraState, type EntityId } from "../core";
import { createCamera } from "./camera";
import { createSelectTool, type GestureFeedback } from "./gestures";
import { drawFeedback } from "./feedback";
import { createInputRouter, type InputRouter } from "./input";
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
}

export function createBoard<D = unknown>(
  init: CreateBoardOptions<D> = {},
): Board<D> {
  const { kinds: initial, camera: start, tool: first, ...rest } = init;
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
    const { router, renderer, container } = mounted;
    showFeedback(null);
    router.destroy();
    renderer.destroy();
    container.style.cursor = "";
    mounted = null;
    active = false;
  };
  const stopCamera = camera.subscribe((state) => board.emit("camera", state));

  const board: Board<D> = {
    camera,
    scene,
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
      });
      mounted = { container, renderer, router, draft: null };
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
    },
    gestureActive: () => active,
    hostOf: (id) => mounted?.renderer.hosts.hostOf(id),
    rasterize: (ids, opts = {}) =>
      rasterize(
        scene,
        kind,
        ids,
        opts,
        browserRasterEnv({ theme: options.theme }),
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
