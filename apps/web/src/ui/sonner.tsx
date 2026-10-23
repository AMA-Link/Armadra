"use client";

import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { Spinner } from "@/ui/spinner";
import { StatusDot } from "@/ui/status-pill";

/**
 * 主题取自 `<html data-theme>`（由 preferences/Preferences.tsx 维护）。
 *
 * shadcn 默认这里用 next-themes，但本项目不是 Next.js，而且应用主题
 * 未必等于 `prefers-color-scheme`，所以直接盯住那个属性。
 */
export function useDocumentTheme(): "light" | "dark" {
  const [theme, setTheme] = React.useState<"light" | "dark">("dark");

  React.useEffect(() => {
    const root = document.documentElement;
    const sync = () =>
      setTheme(root.dataset.theme === "light" ? "light" : "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

/**
 * 全局只挂一个。配置固定（设计系统 §9）：最多 3 层、间距 8、边距 16、不用 richColors、
 * 悬停展开并暂停计时、标签页隐藏时暂停、热键默认（⌥T）。外观走 `ui/toast` 的
 * `toast.custom` 壳；这里的 `icons` 与 `--normal-*` 只给不经 `ui/toast` 的直接调用兜底。
 * 位置与边距可由调用方覆盖（手机顶部出、让开安全区）。
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useDocumentTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      visibleToasts={3}
      gap={8}
      offset={16}
      richColors={false}
      icons={{
        success: <StatusDot tone="done" size={6} />,
        info: <StatusDot tone="unread" size={6} />,
        warning: <StatusDot tone="attention" size={6} />,
        error: <StatusDot tone="failed" size={6} />,
        loading: <Spinner size={12} />,
      }}
      style={
        {
          "--normal-bg": "var(--surface-overlay)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border-strong)",
          "--border-radius": "var(--r-panel)",
          // sonner 自带 z-index 999999999，会盖过开屏；挂到 token 栈（设计系统 §2.11）
          zIndex: "var(--z-toast)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
