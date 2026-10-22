/**
 * `window.armadra.windows` — 桌面壳另开一扇窗口（`window:open`，
 * `apps/desktop/src/main/window.ts` 的 `openSourceWindow`）：新窗口的页面地址带
 * `?source=<sourceId>`，页面以它为初始当前源（「切换服务」对话框，A7-1）。
 * 服务器壳与手机没有这个域。
 */
interface ArmadraBridge {
  readonly windows?: {
    openSource(request: {
      sourceId: string;
    }): Promise<{ readonly opened: boolean }>;
    /**
     * 主题偏好与半透明开关（`window:appearance`，#474）：壳写 `nativeTheme`、
     * 按开关挂摘 vibrancy。旧版本的壳没有这一项。
     */
    setAppearance?(appearance: {
      theme: "system" | "light" | "dark";
      translucent: boolean;
    }): Promise<{ readonly ok: boolean }>;
  };
}
