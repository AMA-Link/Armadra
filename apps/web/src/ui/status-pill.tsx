import * as React from "react";

import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Spinner } from "@/ui/spinner";
import { TextSwap } from "@/ui/text-swap";

/**
 * 状态组件族（设计系统 §11.1）：同一语义（运行中 / 需要你 / 失败 / 完成 / 排队 /
 * 暂停 / 未读 / 空闲）只有三种形态，共享下面的 `TONE_COLOR / STATUS_PILL_TEXT /
 * STATUS_PILL_PULSES`：
 *
 * - `StatusDot`：只有一个圆点（6 / 8），用在前导点、角标、窄节点；文字进无障碍名。
 * - `StatusPill`：`Badge` 的薄封装（sm 18 / md 20）+ 前置圆点 + 文字，用在表格状态列、
 *   节点头（宽节点）、通知行。
 * - `StatusLine`：一行 `阶段 · 细节 · 计时`，用在时间线活动行、抽屉成员行、活动卡。
 *
 * 颜色与脉冲只在这里映射一次，功能代码不再自己写 TONE 表。文案由调用方经 i18n
 * 给出。呼吸动画在 `prefers-reduced-motion` 下静止，状态永远同时由“文字 + 颜色”
 * 表达，不靠动画传递信息。
 */
export type StatusTone =
  | "working"
  | "attention"
  | "failed"
  | "queued"
  | "paused"
  | "unread"
  | "idle"
  /** 已完成（设计系统 §2.3：done = success），会话行与工作流运行记录用。 */
  | "done";

/** 图形色：圆点与衬底的色相（`--status-*`）。 */
export const TONE_COLOR: Record<StatusTone, string> = {
  working: "var(--status-working)",
  attention: "var(--status-attention)",
  failed: "var(--status-failed)",
  queued: "var(--status-queued)",
  paused: "var(--status-paused)",
  unread: "var(--status-unread)",
  idle: "var(--status-idle)",
  done: "var(--status-done)",
};

/**
 * 文字色（设计系统 §2.3 三件套里的 `-text`）。图形色只保证 ≥ 3:1，拿来写字
 * 在深色 working 上只有约 3.6，所以字一律换成对应的文字 token；idle 的
 * `--faint` 也只是图形级，字退到 `--muted-foreground`。
 */
export const STATUS_PILL_TEXT: Record<StatusTone, string> = {
  working: "--working-text",
  attention: "--warn-text",
  failed: "--danger-text",
  queued: "--muted-foreground",
  paused: "--muted-foreground",
  unread: "--brand-text",
  idle: "--muted-foreground",
  done: "--success-text",
};

/** 衬底 = 图形色按这个百分比混进透明。15% 时深色 working 字只有约 4.3。 */
export const STATUS_PILL_TINT = 10;

/**
 * 兜底文案：界面里的胶囊一律由调用方传 `t(...)` 的本地化串，
 * 这里只是给测试与非本地化调用点一个可读的默认值（首字母大写，不全大写）。
 */
export const STATUS_PILL_LABELS: Record<StatusTone, string> = {
  working: "Running",
  attention: "Needs you",
  failed: "Turn failed",
  queued: "Queued",
  paused: "Paused",
  unread: "Unread",
  idle: "Idle",
  done: "Done",
};

/** 默认会脉冲的两种状态：正在跑、需要你。其余静止（§3.4）。 */
export const STATUS_PILL_PULSES: Record<StatusTone, boolean> = {
  working: true,
  attention: true,
  failed: false,
  queued: false,
  paused: false,
  unread: false,
  idle: false,
  done: false,
};

export interface StatusPillProps
  extends Omit<React.ComponentProps<"span">, "children"> {
  tone: StatusTone;
  label: React.ReactNode;
  /** 18（`sm`，默认）或 20（`md`）；与 `Badge` 同高。 */
  size?: "sm" | "md";
  /** 圆点是否呼吸。不传时按 `STATUS_PILL_PULSES` 取默认。 */
  pulse?: boolean;
  /** 尾随内容，例如队列状态的 ▶。 */
  trailing?: React.ReactNode;
}

export function StatusPill({
  tone,
  label,
  size = "sm",
  pulse,
  trailing,
  className,
  style,
  ...props
}: StatusPillProps) {
  const color = TONE_COLOR[tone];
  const shouldPulse = pulse ?? STATUS_PILL_PULSES[tone];
  return (
    <Badge
      variant="secondary"
      size={size}
      data-slot="status-pill"
      data-tone={tone}
      style={{
        color: `var(${STATUS_PILL_TEXT[tone]})`,
        backgroundColor: `color-mix(in srgb, ${color} ${STATUS_PILL_TINT}%, transparent)`,
        ...style,
      }}
      className={cn("gap-1 py-0", size === "sm" ? "px-1.5" : "px-2", className)}
      {...props}
    >
      <span
        data-slot="status-pill-dot"
        aria-hidden
        style={{ backgroundColor: color }}
        className={cn(
          "size-[6px] shrink-0 rounded-pill",
          shouldPulse && "anim-dot-pulse",
        )}
      />
      {label}
      {trailing}
    </Badge>
  );
}

export interface StatusDotProps extends React.ComponentProps<"span"> {
  tone: StatusTone;
  /** 点径：6（行内 / 角标）或 8（节点头 / 会话行前导）。默认 8。 */
  size?: 6 | 8;
  /** 无障碍名（状态文案）。不传就当装饰（旁边已有文字）。 */
  label?: string;
  pulse?: boolean;
  /** 自定义颜色（如成员色），盖过 tone。 */
  color?: string;
  /** 贴在图标右上角，带 2px `--panel` 外环；父元素要 `relative`。 */
  corner?: boolean;
}

/**
 * 只有一个圆点的状态。`idle` 画成暗点（`--faint`）；节点头把空闲当常态不传。
 * 文字进 `aria-label`，不用原生 `title` 解释。
 */
export function StatusDot({
  tone,
  size = 8,
  label,
  pulse,
  color,
  corner = false,
  className,
  style,
  ...props
}: StatusDotProps) {
  const shouldPulse = pulse ?? STATUS_PILL_PULSES[tone];
  const named = label !== undefined;
  return (
    <span
      {...(named
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      data-slot="status-dot"
      data-tone={tone}
      data-size={size}
      style={{ backgroundColor: color ?? TONE_COLOR[tone], ...style }}
      className={cn(
        "shrink-0 rounded-pill",
        size === 6 ? "size-[6px]" : "size-2",
        corner &&
          "absolute top-0 right-0 translate-x-1/3 -translate-y-1/3 ring-2 ring-panel",
        shouldPulse && "anim-dot-pulse",
        className,
      )}
      {...props}
    />
  );
}

/** `StatusLine` 的输入：`agent/display.ts` 的 `lineOf` 产出同一形状，但本组件不依赖 `agent/`。 */
export interface StatusLineProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  tone: StatusTone;
  /** 阶段文案（已本地化）；`aria-live="polite"` 只播这一段。 */
  label: string;
  /** 阶段后的细节：工具标题、命令、文件名（等宽、可截断）。 */
  detail?: string | undefined;
  /** 阶段开始的时间戳（毫秒），显示为实时跳动的计时；不传不显示。 */
  since?: number | undefined;
  /** 跑着的阶段：前导换成 `Spinner 12`。审批 / 出错不转圈。 */
  spinning?: boolean | undefined;
  /** 紧凑：只阶段 + 计时。 */
  compact?: boolean;
  /** 测试用：固定当前时间。 */
  now?: number;
}

function useNow(active: boolean, fixed: number | undefined): number {
  const [now, setNow] = React.useState(() => fixed ?? Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return fixed ?? now;
}

/**
 * 一行状态：前导（`Spinner 12` 或 `StatusDot 6`）+ 阶段（`text-body`，换阶段用
 * `TextSwap`）+ 细节（`text-meta` 等宽）+ 计时（等宽）。计时不进读屏。
 */
export function StatusLine({
  tone,
  label,
  detail,
  since,
  spinning = false,
  compact = false,
  now: fixedNow,
  className,
  ...props
}: StatusLineProps) {
  const ticking = since !== undefined && fixedNow === undefined;
  const now = useNow(ticking, fixedNow);
  const elapsed =
    since === undefined ? undefined : formatDuration(Math.max(0, now - since));
  return (
    <div
      data-slot="status-line"
      data-tone={tone}
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-body text-foreground",
        className,
      )}
      {...props}
    >
      {spinning ? (
        <Spinner size={12} className="text-muted-foreground" />
      ) : (
        <StatusDot tone={tone} size={6} />
      )}
      <span
        data-slot="status-line-phase"
        aria-live="polite"
        className="shrink-0"
      >
        <TextSwap>{label}</TextSwap>
      </span>
      {!compact && detail !== undefined && detail !== "" && (
        <span
          data-slot="status-line-detail"
          className="min-w-0 truncate font-mono text-meta text-muted-foreground"
        >
          {detail}
        </span>
      )}
      {elapsed !== undefined && (
        <span
          data-slot="status-line-since"
          data-numeric
          className="shrink-0 font-mono text-meta text-muted-foreground"
        >
          {elapsed}
        </span>
      )}
    </div>
  );
}
