import * as React from "react";

import { usePreferencesStore } from "@/app/preferences-store";
import { isCanvasLocked } from "../../canvas-lock";
import { registerCanvasCommands } from "../../commands";
import { setDefaultStyle } from "../../interaction/tool-store";
import { openMermaidImport } from "../mermaid/open";

/** 两种引擎的白板工具层共用的命令与偏好推送（不依赖 React Flow）。 */

/** ⌘⇧M / 加号菜单的「导入 Mermaid…」；锁住的画布上不响应。 */
export function useMermaidCommand(): void {
  React.useEffect(
    () =>
      registerCanvasCommands({
        "canvas.importMermaid": () => {
          if (isCanvasLocked()) return;
          openMermaidImport();
        },
      }),
    [],
  );
}

/**
 * 「默认颜色 / 粗细」偏好 → 下一个对象的样式（§2.10）。
 *
 * 单向：偏好改了就推一次。样式面板改的是 `nextStyle`，不写回偏好——
 * 否则「这一笔想画红的」会永久改掉默认值。
 */
export function useDefaultStyle(): void {
  const color = usePreferencesStore((state) => state.whiteboard.defaultColor);
  const size = usePreferencesStore((state) => state.whiteboard.defaultSize);
  React.useEffect(() => {
    setDefaultStyle({ color, size });
  }, [color, size]);
}
