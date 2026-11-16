// 手势反馈的缺省画法：框选框、连线草稿、绘制草稿，画在叠加层的世界坐标 SVG 里。
import type { Camera } from "./types";
import { anchorPoint, type Rect, type Scene, type Vec } from "../core";
import type { GestureFeedback } from "./gestures";

const NS = "http://www.w3.org/2000/svg";

/** 把反馈画进 `svg`，返回画出的元素（调用方下次先移除）；画不出就返回 null。 */
export function drawFeedback(
  svg: SVGSVGElement,
  fb: GestureFeedback,
  scene: Scene,
  camera: Camera,
): SVGElement | null {
  const px = 1 / camera.get().zoom;
  const el = (tag: string, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(NS, tag) as SVGElement;
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", String(1.5 * px));
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, `${v}`);
    return node;
  };
  let shape: SVGElement | null = null;
  if (fb.type === "marquee") {
    shape = el("rect", {
      ...fb.rect,
      "stroke-dasharray": 4 * px,
      fill: "currentColor",
      "fill-opacity": 0.08,
    });
  } else if (fb.type === "connect") {
    const box = scene.bounds(fb.from);
    if (!box) return null;
    const at = anchorPoint({ ...box, width: box.w, height: box.h }, fb.side);
    shape = el("path", {
      d: `M${at.x} ${at.y}L${fb.to.x} ${fb.to.y}`,
      "stroke-dasharray": fb.over ? 0 : 6 * px,
    });
  } else {
    const d = fb.draft as Partial<Rect> & { points?: Vec[] };
    if (d?.points?.length) {
      shape = el("polyline", {
        points: d.points.map((p: Vec) => `${p.x},${p.y}`).join(" "),
      });
    } else if (d && d.x !== undefined && d.w !== undefined) {
      shape = el("rect", d as Record<string, number>);
    }
  }
  return shape ? svg.appendChild(shape) : null;
}
