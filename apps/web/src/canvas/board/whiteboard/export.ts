import { createMemoryScene, type Entity } from "@armadra/board/core";
import {
  browserRasterEnv,
  rasterize,
  type DomKindSpec,
} from "@armadra/board/dom";

import { useCanvasStore } from "@/store/canvas-store";
import type { RasterOptions } from "../../whiteboard/raster";
import { toItemId, type Item } from "../../whiteboard/model";
import { colorHex } from "../../whiteboard/palette";
import { peekImage, preloadImages, setImageWorkspace } from "./images";
import { whiteboardKinds, wbKindOf } from "./kinds";

/**
 * 白板对象 → PNG：与屏幕同一套 `paint`（设计 §2.7）。
 *
 * 把这些对象放进一个临时的内存场景，交给引擎的 `rasterize`（与 `board.rasterize`
 * 同一个函数）——不依赖哪个引擎正在显示，所以内容引用与图片粘贴在两种引擎下
 * 导出的是同一张图。颜色按调用方指定的那一套（缺省浅色：导出的图多半贴进文档里看）。
 */
export async function exportItemsPng(
  items: readonly Item[],
  options: RasterOptions,
): Promise<Blob> {
  const kinds = whiteboardKinds() as unknown as Record<
    string,
    DomKindSpec<Item>
  >;
  const scene = createMemoryScene<Item>({ kinds: (name) => kinds[name] });
  const ordered = [...items].sort((a, b) => a.z - b.z);
  scene.transact(
    (draft) => {
      for (const item of ordered) {
        const entity: Entity<Item> = {
          id: toItemId(item.id),
          kind: wbKindOf(item),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          z: item.z,
          data: item,
        };
        draft.set(entity);
      }
    },
    { history: "ignore" },
  );
  setImageWorkspace(useCanvasStore.getState().workspace?.id ?? null);
  const scheme = options.scheme ?? "light";
  return rasterize(
    scene,
    (name) => kinds[name],
    ordered.map((item) => toItemId(item.id)),
    {
      scale: options.scale ?? 2,
      padding: options.padding ?? 16,
      background: options.background ?? null,
    },
    browserRasterEnv({
      theme: scheme,
      color: (name) => colorHex(name, scheme),
      image: peekImage,
      prepare: () =>
        preloadImages(
          ordered.flatMap((item) =>
            item.kind === "image" ? [item.assetPath] : [],
          ),
          options.resolveImage,
        ),
    }),
  );
}
