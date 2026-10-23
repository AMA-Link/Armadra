import * as React from "react";
import { CheckIcon, CopyIcon, PlayIcon } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { AnimatedNumber } from "@/ui/animated-number";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Indicator, IndicatorGroup, useIndicatorHover } from "@/ui/indicator";
import { Input } from "@/ui/input";
import { Shimmer } from "@/ui/shimmer";
import { Spinner, type SpinnerState } from "@/ui/spinner";
import { TextSwap } from "@/ui/text-swap";

import {
  CHECK_SPIN_MS,
  INDICATOR_ITEMS,
  MOTION_RECIPES,
  ROLL_VALUES,
  SHAKE_VALUE,
  SHIMMER_LABEL,
  STAGGER_ROWS,
  type MotionRecipe,
} from "../fixtures/motion";
import { Sample } from "./sample";

/**
 * `motion` 分区（设计展示页 §2.1）：设计系统 §8 的十个配方各一格——按下、发芽、
 * 指示器平移、文字替换、数字滚动、列表错落、图标切换、shake、shimmer、对勾画出。
 *
 * 每格右上角是重放（整格重新挂载，动画从头播）；会动的配方旁边放一帧强制的
 * 起始 / 按下态，截图是静态的，看得出起点是多少。减少动效下（探针用
 * `prefers-reduced-motion: reduce` 再截一遍）位移、缩放、循环停掉，只剩透明度。
 */

const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-(--space-group)";

/** 一格：配方名在 `Sample` 里，重放在右上。`children` 拿到当前的重放序号。 */
function Cell({
  recipe,
  children,
}: {
  recipe: MotionRecipe;
  children: (run: number) => React.ReactNode;
}) {
  const t = useT();
  const [run, setRun] = React.useReducer((count: number) => count + 1, 0);
  return (
    <div
      data-motion-cell={recipe}
      className="relative flex min-h-28 flex-col justify-between rounded-card border border-border bg-card p-4"
    >
      <IconButton
        label={t("showcase.tokens.play")}
        size="inline"
        className="absolute top-2 right-2"
        onClick={setRun}
      >
        <PlayIcon />
      </IconButton>
      <div key={run} className="contents">
        {children(run)}
      </div>
    </div>
  );
}

/** 按下：活的按钮 + 一帧强制的 `scale(var(--press-scale))`。 */
function Press() {
  return (
    <Sample name="press">
      <Button variant="outline" size="sm">
        Run
      </Button>
      <Button
        variant="outline"
        size="sm"
        data-forced="pressed"
        style={{ transform: "scale(var(--press-scale))" }}
      >
        Run
      </Button>
    </Sample>
  );
}

/** 发芽：菜单类（0.96 起，触发点为 origin）、Tooltip（0.97 起）各一块，旁边是起始帧。 */
function Pop() {
  return (
    <Sample name="pop">
      <div
        data-state="open"
        className="motion-pop h-12 w-24 origin-top-left rounded-panel border border-border bg-popover shadow-overlay"
      />
      <div
        data-forced="start"
        className="h-12 w-24 origin-top-left rounded-panel border border-border bg-popover opacity-50 shadow-overlay"
        style={{ transform: "scale(var(--pop-scale))" }}
      />
      <div
        data-state="open"
        className="motion-tip origin-bottom rounded-control bg-foreground px-2 py-1 text-caption text-background"
      >
        ⌘K
      </div>
    </Sample>
  );
}

/** 指示器平移：当前项与悬停底是各自的一块，在组内平移而不是各自变色。 */
function IndicatorTabs({
  active,
  onPick,
}: {
  active: string;
  onPick: (item: string) => void;
}) {
  const { hovered, hoverProps } = useIndicatorHover();
  return (
    <div className="relative flex gap-1 rounded-card border border-border bg-muted p-0.5">
      {INDICATOR_ITEMS.map((item) => (
        <Button
          key={item}
          variant="ghost"
          size="sm"
          static
          data-active={item === active ? "true" : undefined}
          className="relative isolate text-muted-foreground hover:bg-transparent data-[active=true]:text-foreground"
          onClick={() => onPick(item)}
          {...hoverProps(item)}
        >
          {hovered === item && item !== active && (
            <Indicator
              kind="hover"
              className="inset-0 rounded-control bg-hover"
            />
          )}
          {item === active && (
            <Indicator className="inset-0 rounded-control border border-border bg-background" />
          )}
          {item}
        </Button>
      ))}
    </div>
  );
}

function IndicatorDemo() {
  const [active, setActive] = React.useState<string>(INDICATOR_ITEMS[1]);
  return (
    <Sample name="indicator">
      <IndicatorGroup id="showcase-motion-indicator">
        <IndicatorTabs active={active} onPick={setActive} />
      </IndicatorGroup>
    </Sample>
  );
}

/** 文字替换：旧字淡出 + 模糊 2px，新字反向，容器宽度平滑。 */
function SwapDemo() {
  const t = useT();
  const [copied, setCopied] = React.useState(false);
  return (
    <Sample name="text-swap">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setCopied((value) => !value)}
      >
        <TextSwap>
          {copied ? t("showcase.sample.copied") : t("showcase.sample.copy")}
        </TextSwap>
      </Button>
    </Sample>
  );
}

/** 数字滚动：首次出现从 0 填到当前值，之后在两个值之间滚。 */
function RollDemo() {
  const [index, setIndex] = React.useState(0);
  return (
    <Sample name="number-roll">
      <span className="font-mono text-section font-semibold">
        <AnimatedNumber
          fromZero
          value={ROLL_VALUES[index]!}
          format={(value) => new Intl.NumberFormat().format(Math.round(value))}
        />
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => setIndex((value) => 1 - value)}
      >
        ⇄
      </Button>
    </Sample>
  );
}

/** 列表错落：第 i 项延迟 i × 40ms，最多前六项。 */
function StaggerDemo() {
  return (
    <Sample name="list-stagger" wide>
      <ul className="flex w-full flex-col">
        {STAGGER_ROWS.map((row, index) => (
          <li
            key={row}
            data-stagger-index={index}
            className="motion-enter-list flex items-center rounded-control px-2 py-1 text-body"
            style={{ "--i": index } as React.CSSProperties}
          >
            {row}
          </li>
        ))}
      </ul>
    </Sample>
  );
}

/** 图标切换：两枚图标都在，一枚绝对定位；缩放 + 透明度 + 模糊，减少动效下只留透明度。 */
function IconSwapDemo() {
  const [done, setDone] = React.useState(false);
  const base =
    "absolute transition-[opacity,transform,filter] duration-(--dur-base) ease-(--ease-out) motion-reduce:scale-100 motion-reduce:blur-none";
  const hidden = "scale-25 opacity-0 blur-[4px]";
  return (
    <Sample name="icon-swap">
      <Button
        variant="outline"
        size="icon-sm"
        aria-pressed={done}
        aria-label="icon-swap"
        onClick={() => setDone((value) => !value)}
      >
        <span className="relative flex size-4 items-center justify-center">
          <CopyIcon className={cn(base, done && hidden)} />
          <CheckIcon className={cn(base, !done && hidden)} />
        </span>
      </Button>
    </Sample>
  );
}

/** shake：`aria-invalid` 的那一刻抖两次（±4px，240ms 匀速），红边由输入框自带。 */
function ShakeDemo({ run }: { run: number }) {
  return (
    <Sample name="shake">
      <Input
        key={run}
        aria-label="shake"
        aria-invalid
        defaultValue={SHAKE_VALUE}
        className="w-44"
      />
    </Sample>
  );
}

/** shimmer：遮罩扫过，文字色不变；旁边是静止的同一行。 */
function ShimmerDemo() {
  return (
    <Sample name="shimmer">
      <Shimmer className="text-body text-muted-foreground">
        {SHIMMER_LABEL}
      </Shimmer>
      <Shimmer active={false} className="text-body text-muted-foreground">
        {SHIMMER_LABEL}
      </Shimmer>
    </Sample>
  );
}

/**
 * 对勾画出：第一次是静止的转圈（截图稳定），点重放后转 `CHECK_SPIN_MS` 再收成对勾
 * （240ms 画出）；旁边是终态 done / failed。
 */
function CheckDemo({ run }: { run: number }) {
  const t = useT();
  const [state, setState] = React.useState<SpinnerState>("spinning");
  React.useEffect(() => {
    if (run === 0) return;
    const timer = window.setTimeout(() => setState("done"), CHECK_SPIN_MS);
    return () => window.clearTimeout(timer);
  }, [run]);
  return (
    <Sample name="check-draw">
      <Spinner state={state} aria-label={t("state.loading")} />
      <Spinner state="done" />
      <Spinner state="failed" />
    </Sample>
  );
}

export default function MotionSection() {
  const cell = (
    recipe: MotionRecipe,
    body: (run: number) => React.ReactNode,
  ) => (
    <Cell key={recipe} recipe={recipe}>
      {body}
    </Cell>
  );
  const bodies: Record<MotionRecipe, (run: number) => React.ReactNode> = {
    press: () => <Press />,
    pop: () => <Pop />,
    indicator: () => <IndicatorDemo />,
    "text-swap": () => <SwapDemo />,
    "number-roll": () => <RollDemo />,
    "list-stagger": () => <StaggerDemo />,
    "icon-swap": () => <IconSwapDemo />,
    shake: (run) => <ShakeDemo run={run} />,
    shimmer: () => <ShimmerDemo />,
    "check-draw": (run) => <CheckDemo run={run} />,
  };
  return (
    <div className={GRID}>
      {MOTION_RECIPES.map((recipe) => cell(recipe, bodies[recipe]))}
    </div>
  );
}
