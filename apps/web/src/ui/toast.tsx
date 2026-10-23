"use client";

import * as React from "react";
import { toast as sonner } from "sonner";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { StatusDot, type StatusTone } from "@/ui/status-pill";

/**
 * 提示的唯一入口（设计系统 §3.3 / §9）：功能代码从这里取 `toast`，不直接
 * `import { toast } from "sonner"`（`class-guards.test.ts` 拦）。外观是本设计系统的壳
 * （`--surface-overlay`、1px `--border-strong`、`rounded-panel`、`--shadow-overlay`），
 * 经 sonner 的 `toast.custom` 渲染，不用 `!important` 去盖默认样式。
 *
 * 用法与 sonner 一致，选项只留常用的：
 *
 * ```ts
 * toast.error("没有放到画板上", { action: { label: "重试", onClick: retry } });
 * const id = toast.loading("正在导出");
 * toast.success("已导出", { id });                // 同一事件更新同一条
 * toast.promise(save(), { loading: "…", success: "已保存", error: "保存失败" });
 * ```
 *
 * 规则：失败与可撤销的动作才弹；成功默认不弹，用文字替换式反馈（`TextSwap`）。
 * 带动作或错误的不自动消失（`duration: Infinity`）。堆叠、悬停展开、滑动关闭、
 * 标签页隐藏时暂停计时都由 `Toaster` 配置负责。
 */
export type ToastKind = "success" | "error" | "info" | "warning" | "loading";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** 动作的快捷键提示（给人看的写法）。 */
  shortcut?: string;
}

export interface ToastOptions {
  /** 第二行，`text-meta` 灰字；只给错误的具体原因，不写解释。 */
  description?: React.ReactNode;
  action?: ToastAction;
  /** 同一事件更新同一条时传同一个 id。 */
  id?: string | number;
  /** 毫秒；不传：错误与带动作的是 `Infinity`，其余 4000。 */
  duration?: number;
  onDismiss?: () => void;
  onAutoClose?: () => void;
}

/** 自动消失的默认时长。 */
export const TOAST_DURATION_MS = 4000;

const TONE: Record<Exclude<ToastKind, "loading">, StatusTone> = {
  success: "done",
  error: "failed",
  info: "unread",
  warning: "attention",
};

/** 一条提示该停多久：错误与带动作的不自动消失。 */
export function toastDuration(
  kind: ToastKind,
  options?: Pick<ToastOptions, "action" | "duration">,
): number {
  if (options?.duration !== undefined) return options.duration;
  if (kind === "error" || options?.action !== undefined) return Infinity;
  if (kind === "loading") return Infinity;
  return TOAST_DURATION_MS;
}

function ToastShell({
  kind,
  message,
  description,
  action,
  id,
}: {
  kind: ToastKind;
  message: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastAction;
  id: string | number;
}) {
  return (
    <div
      role="status"
      data-slot="toast"
      data-kind={kind}
      className="flex w-full items-start gap-2 rounded-panel border border-border-strong bg-overlay p-3 text-body text-popover-foreground shadow-overlay"
    >
      <span className="flex h-[19px] shrink-0 items-center">
        {kind === "loading" ? (
          <Spinner size={12} className="text-muted-foreground" />
        ) : (
          <StatusDot tone={TONE[kind]} size={6} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="[overflow-wrap:anywhere]">{message}</div>
        {description !== undefined && (
          <div className="text-meta text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </div>
        )}
      </div>
      {action !== undefined && (
        <Button
          variant="outline"
          size="xs"
          className={cn("shrink-0")}
          {...(action.shortcut === undefined
            ? {}
            : { shortcut: action.shortcut })}
          onClick={() => {
            action.onClick();
            sonner.dismiss(id);
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

function show(
  kind: ToastKind,
  message: React.ReactNode,
  options: ToastOptions = {},
): string | number {
  const { id, onDismiss, onAutoClose, description, action } = options;
  return sonner.custom(
    (toastId) => (
      <ToastShell
        kind={kind}
        message={message}
        id={toastId}
        {...(description === undefined ? {} : { description })}
        {...(action === undefined ? {} : { action })}
      />
    ),
    {
      duration: toastDuration(kind, options),
      ...(id === undefined ? {} : { id }),
      ...(onDismiss === undefined ? {} : { onDismiss }),
      ...(onAutoClose === undefined ? {} : { onAutoClose }),
    },
  );
}

type PromiseText<T> = React.ReactNode | ((value: T) => React.ReactNode);

function resolveText<T>(text: PromiseText<T>, value: T): React.ReactNode {
  return typeof text === "function"
    ? (text as (value: T) => React.ReactNode)(value)
    : text;
}

/**
 * 加载 → 成功 / 失败：同一个 id 原地更新。成功只停 2 秒（完成反馈），失败不自动消失。
 * 返回原 promise 的结果，调用方可以继续 `await`。
 */
function promise<T>(
  work: Promise<T> | (() => Promise<T>),
  text: {
    loading: React.ReactNode;
    success: PromiseText<T>;
    error: PromiseText<unknown>;
    description?: PromiseText<unknown>;
  },
): { id: string | number; result: Promise<T> } {
  const id = show("loading", text.loading);
  const result = (typeof work === "function" ? work() : work).then(
    (value) => {
      show("success", resolveText(text.success, value), {
        id,
        duration: 2000,
      });
      return value;
    },
    (error: unknown) => {
      show("error", resolveText(text.error, error), {
        id,
        ...(text.description === undefined
          ? {}
          : { description: resolveText(text.description, error) }),
      });
      throw error;
    },
  );
  return { id, result };
}

const base = (message: React.ReactNode, options?: ToastOptions) =>
  show("info", message, options);

export const toast = Object.assign(base, {
  success: (message: React.ReactNode, options?: ToastOptions) =>
    show("success", message, options),
  error: (message: React.ReactNode, options?: ToastOptions) =>
    show("error", message, options),
  info: (message: React.ReactNode, options?: ToastOptions) =>
    show("info", message, options),
  warning: (message: React.ReactNode, options?: ToastOptions) =>
    show("warning", message, options),
  /** 与 `info` 同义（旧调用点沿用的名字）。 */
  message: (message: React.ReactNode, options?: ToastOptions) =>
    show("info", message, options),
  loading: (message: React.ReactNode, options?: ToastOptions) =>
    show("loading", message, options),
  promise,
  dismiss: (id?: string | number) => sonner.dismiss(id),
});
