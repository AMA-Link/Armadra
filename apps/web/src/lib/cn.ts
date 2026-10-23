import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * 设计系统自己的类名：tailwind-merge 认不出它们，会把 `text-meta` 当成颜色、
 * `rounded-control` 当成未知，结果 `cn("text-meta", "text-danger-text")` 丢掉其中一个、
 * `cn("rounded-control", "rounded-full")` 两个都留着。这里登记进对应的类组，冲突才
 * 按调用者的意图消解。名字与 `styles/app.css` 的 `@theme` 一一对应。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["display", "title", "section", "body", "meta", "caption"],
        },
      ],
      rounded: [
        {
          rounded: [
            "tight",
            "control",
            "card",
            "panel",
            "dialog",
            "float",
            "pill",
          ],
        },
      ],
      shadow: [{ shadow: ["node", "overlay", "dialog"] }],
    },
  },
});

/**
 * 合并 class：先用 clsx 展开条件表达式，再用 tailwind-merge 消解冲突。
 *
 * 冲突消解是必须的——`src/ui/*` 的组件都接受 `className` 覆盖，
 * 没有 twMerge 的话 `<Button className="px-6">` 会和内置的 `px-3` 同时存在，
 * 结果取决于 CSS 里的书写顺序而不是调用者的意图。
 *
 * 裸的 `from "cn"`（npm 包）在构建与测试里都别名到这个文件（`vite.config.ts`、
 * `vitest.config.ts`），免得 shadcn CLI 生成的组件用上一个不认识设计系统类名的合并器。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
