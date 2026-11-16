import * as React from "react";
import { Hand, Maximize, MousePointer2, Pencil } from "lucide-react";
import {
  routeFor,
  roundedPath,
  type Entity,
  type Vec,
} from "@armadra/board/core";
import {
  createBoard,
  createDraw,
  createHandTool,
  createMinimap,
  createSelectTool,
  type DomBoard,
  type DomKindSpec,
  type Tool,
} from "@armadra/board/dom";

import { useT } from "@/app/preferences-store";
import { IconButton } from "@/ui/icon-button";

/**
 * 画板引擎的独立演示（Armadra#952 B2）：只用 `@armadra/board/dom`，不接应用状态。
 * 世界层 DOM 卡片、画布层矩形与墨迹、连线都是演示自己注册的种类。
 */

interface Data {
  title?: string;
  points?: Vec[];
  tint?: string;
}
type Item = Entity<Data>;

const CORNERS = ["nw", "ne", "sw", "se"] as const;
const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNER_AT: Record<string, string> = {
  nw: "-left-1 -top-1 cursor-nwse-resize",
  ne: "-right-1 -top-1 cursor-nesw-resize",
  sw: "-left-1 -bottom-1 cursor-nesw-resize",
  se: "-right-1 -bottom-1 cursor-nwse-resize",
};
const SIDE_AT: Record<string, string> = {
  top: "left-1/2 -top-1.5 -translate-x-1/2",
  right: "-right-1.5 top-1/2 -translate-y-1/2",
  bottom: "left-1/2 -bottom-1.5 -translate-x-1/2",
  left: "-left-1.5 top-1/2 -translate-y-1/2",
};
const REVEAL =
  "opacity-0 group-hover:opacity-100 group-data-[selected]:opacity-100";

/** 画布绘制要真实颜色：从设计 token 读，主题切换后重绘即可跟上。 */
const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const rect = (
  ctx: CanvasRenderingContext2D,
  e: Item,
  fill: string,
  stroke: string,
  selected: boolean,
): void => {
  ctx.beginPath();
  ctx.roundRect(e.x, e.y, e.w, e.h, 12);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? css("--brand") : stroke;
  ctx.stroke();
};

function kindsOf(
  board: () => DomBoard<Data>,
): Record<string, DomKindSpec<Data>> {
  const box = (id: string) => {
    const b = board().scene.bounds(id)!;
    return { x: b.x, y: b.y, width: b.w, height: b.h };
  };
  return {
    card: {
      layer: "world",
      resize: { min: { w: 120, h: 72 } },
      connect: { start: true, end: true },
      obstacle: true,
    },
    zone: {
      layer: "canvas-under",
      resize: { min: { w: 160, h: 120 } },
      connect: { start: false, end: false },
      paint: (ctx, e, env) =>
        rect(ctx, e, css("--brand-soft"), css("--border-strong"), env.selected),
    },
    ink: {
      layer: "canvas-over",
      resize: false,
      connect: { start: false, end: false },
      paint(ctx, e) {
        const [first, ...rest] = e.data.points ?? [];
        if (!first) return;
        ctx.beginPath();
        ctx.moveTo(e.x + first.x, e.y + first.y);
        for (const p of rest) ctx.lineTo(e.x + p.x, e.y + p.y);
        ctx.lineWidth = 2;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.strokeStyle = css("--brand");
        ctx.stroke();
      },
    },
    link: {
      layer: "canvas-under",
      hit: () => false,
      paint(ctx, e) {
        if (!e.ends) return;
        const [a, b] = e.ends;
        const route = routeFor(box(a), box(b));
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = css("--border-strong");
        ctx.stroke(new Path2D(roundedPath(route.points)));
      },
    },
  };
}

function fillCard(host: HTMLElement, title: string): void {
  const handle = (name: string, at: string, shape: string) =>
    `<i data-board-handle="${name}" class="absolute ${at} ${shape} ${REVEAL} size-2.5 rounded-full border border-brand bg-card"></i>`;
  host.innerHTML =
    `<div class="group relative h-full select-none rounded-panel border border-border bg-card p-3 text-body text-card-foreground data-[selected]:border-brand">` +
    `<span class="font-medium">${title}</span>` +
    CORNERS.map((n) => handle(n, CORNER_AT[n]!, "")).join("") +
    SIDES.map((n) => handle(n, SIDE_AT[n]!, "cursor-crosshair")).join("") +
    `</div>`;
}

export function BoardEngineSpecimen() {
  const t = useT();
  const stage = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<HTMLDivElement>(null);
  const boardRef = React.useRef<DomBoard<Data> | null>(null);
  const tools = React.useRef<Record<string, Tool>>({});
  const [tool, setTool] = React.useState("select");
  const [zoom, setZoom] = React.useState(1);

  React.useEffect(() => {
    const container = stage.current!;
    const board: DomBoard<Data> = createBoard<Data>({
      inputDevice: "trackpad",
      color: (name) => (name === "dot" ? css("--canvas-dot") : name),
      kinds: kindsOf(() => board),
    });
    boardRef.current = board;
    // 展示页只在开发构建里存在；截图与探针脚本从这里取板。
    (window as { __boardDemo?: unknown }).__boardDemo = board;
    const { scene } = board;
    let serial = 0;
    const add = (
      kind: string,
      x: number,
      y: number,
      w: number,
      h: number,
      data: Data,
      extra: Partial<Item> = {},
    ) => {
      const id = `${kind}-${++serial}`;
      scene.transact(
        (d) => d.set({ id, kind, x, y, w, h, z: serial, data, ...extra }),
        { history: "ignore" },
      );
      if (kind === "card") fillCard(board.hostOf(id)!, data.title ?? "");
      return id;
    };
    const link = (a: string, b: string) =>
      add("link", 0, 0, 0, 0, {}, { ends: [a, b] });
    const title = (key: string) => t(`showcase.board.card.${key}`);

    board.mount(container);
    add("zone", 40, 30, 520, 300, {});
    const plan = add("card", 80, 80, 160, 90, { title: title("plan") });
    const build = add("card", 340, 60, 160, 90, { title: title("build") });
    const review = add("card", 340, 210, 160, 90, { title: title("review") });
    link(plan, build);
    link(plan, review);
    add("ink", 600, 90, 120, 60, {
      points: [
        { x: 0, y: 40 },
        { x: 30, y: 4 },
        { x: 60, y: 52 },
        { x: 90, y: 10 },
        { x: 120, y: 44 },
      ],
    });
    board.camera.fit({ x: 40, y: 30, w: 700, h: 300 }, { padding: 0.06 });

    tools.current = {
      select: createSelectTool(board.gestureDeps),
      hand: createHandTool(board.gestureDeps),
      ink: {
        id: "ink",
        cursor: "crosshair",
        begin: (input, b) =>
          input.button !== 0
            ? null
            : createDraw<{ points: Vec[] }>(
                { board: b, deps: board.gestureDeps },
                input,
                "ink",
                {
                  start: (p) => ({ points: [p.world] }),
                  extend: (d, p) => ({ points: [...d.points, p.world] }),
                  finish: (d) => (d.points.length > 1 ? d : null),
                },
              ),
      },
    };
    board.setTool(tools.current.select!);

    setZoom(board.camera.get().zoom);
    const syncSelected = () => {
      for (const e of scene.ordered()) {
        const inner = board.hostOf(e.id)
          ?.firstElementChild as HTMLElement | null;
        if (!inner) continue;
        if (board.selection().has(e.id)) inner.dataset.selected = "";
        else delete inner.dataset.selected;
      }
    };
    const offs = [
      board.on("select", syncSelected),
      // 写回要在监听里同步完成：之后引擎立刻清预览。
      board.on("move", ({ positions }) =>
        scene.transact((d) => positions.forEach((p, id) => d.update(id, p)), {
          history: "ignore",
        }),
      ),
      board.on("resize", ({ id, box }) =>
        scene.transact((d) => d.update(id, box), { history: "ignore" }),
      ),
      board.on("connect", ({ from, to, at }) => {
        const target =
          to ??
          add("card", at.x - 80, at.y - 45, 160, 90, { title: title("new") });
        link(from, target);
      }),
      board.on("create", ({ draft }) => {
        const points = (draft as { points: Vec[] }).points;
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const [x, y] = [Math.min(...xs), Math.min(...ys)];
        add("ink", x, y, Math.max(...xs) - x, Math.max(...ys) - y, {
          points: points.map((p) => ({ x: p.x - x, y: p.y - y })),
        });
      }),
      board.camera.subscribe((s) => setZoom(s.zoom)),
    ];

    // 空格 + 拖动 = 平移；指针不在画板上时不拦截空格。
    let over = false;
    const enter = () => (over = true);
    const leave = () => (over = false);
    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code !== "Space" || (down && !over)) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input,textarea,button")
      )
        return;
      board.setModifiers({ space: down });
      if (down) e.preventDefault();
    };
    const [onDown, onUp] = [key(true), key(false)];
    container.addEventListener("pointerenter", enter);
    container.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    const minimap = createMinimap(map.current!, {
      scene,
      camera: board.camera,
      colorOf: (e) =>
        e.kind === "link"
          ? { fill: "", stroke: css("--border-strong") }
          : e.kind === "zone"
            ? css("--brand-soft")
            : css("--muted-foreground"),
    });
    // 展示页切主题：画板跟着换点阵与画布色。
    const theme = () => {
      board.setOptions({
        theme:
          document.documentElement.dataset.theme === "light" ? "light" : "dark",
      });
      minimap.invalidate();
    };
    theme();
    const watch = new MutationObserver(theme);
    watch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      watch.disconnect();
      minimap.destroy();
      container.removeEventListener("pointerenter", enter);
      container.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      offs.forEach((off) => off());
      board.destroy();
      boardRef.current = null;
      delete (window as { __boardDemo?: unknown }).__boardDemo;
    };
  }, [t]);

  const pick = (id: string) => {
    setTool(id);
    boardRef.current?.setTool(tools.current[id]!);
  };
  const buttons = [
    ["select", MousePointer2],
    ["hand", Hand],
    ["ink", Pencil],
  ] as const;
  return (
    <div className="flex flex-col gap-2" data-showcase-board>
      <div className="flex items-center gap-1">
        {buttons.map(([id, Icon]) => (
          <IconButton
            key={id}
            size="cluster"
            variant="ghost"
            label={t(`showcase.board.tool.${id}`)}
            active={tool === id}
            data-active={tool === id}
            onClick={() => pick(id)}
          >
            <Icon />
          </IconButton>
        ))}
        <IconButton
          size="cluster"
          variant="ghost"
          label={t("showcase.board.fit")}
          onClick={() =>
            boardRef.current?.camera.fit(
              { x: 40, y: 30, w: 700, h: 300 },
              { padding: 0.06, duration: 200 },
            )
          }
        >
          <Maximize />
        </IconButton>
        <span className="ml-2 text-meta tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
      </div>
      <div className="relative h-[420px] overflow-hidden rounded-panel border border-border bg-canvas">
        <div
          ref={stage}
          role="application"
          aria-label={t("showcase.board.stage")}
          className="absolute inset-0 text-brand"
        />
        <div
          ref={map}
          className="absolute bottom-3 right-3 h-[90px] w-[150px] overflow-hidden rounded-field border border-border bg-panel"
        />
      </div>
    </div>
  );
}
