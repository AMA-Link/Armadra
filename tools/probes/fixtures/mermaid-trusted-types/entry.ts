// 探针 `mermaid-trusted-types.mjs` 的页面：装上页面的 Trusted Types 策略，再用应用里同一份
// `renderMermaidSvg` 渲染，结果交回探针。
import { installDefaultTrustedTypesPolicy } from "@/lib/trusted-types";
import { renderMermaidSvg } from "@/canvas/whiteboard/mermaid/render";

installDefaultTrustedTypesPolicy();

(globalThis as { renderMermaid?: unknown }).renderMermaid = async (
  text: string,
) => {
  const svg = await renderMermaidSvg(text);
  // 与导入对话框的预览同一种显示：`blob:` 图片。
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
  URL.revokeObjectURL(url);
  return { svg, loaded, width: image.naturalWidth };
};
