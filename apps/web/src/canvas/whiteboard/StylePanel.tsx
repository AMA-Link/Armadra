import * as React from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  ArrowRight,
  Minus,
} from "lucide-react";

import { useT } from "@/app/preferences-store";
import { usePreferencesStore } from "@/app/preferences-store";
import {
  WHITEBOARD_COLORS,
  WHITEBOARD_SIZES,
  type WhiteboardColor,
  type WhiteboardSize,
} from "@/app/preferences/whiteboard";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Separator } from "@/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/cn";
import { useCanvasStore } from "@/store/canvas-store";
import { setNextStyle, useNextStyle, useTool } from "../interaction/tool-store";
import { shouldShowStylePanel } from "../tools";
import {
  DASHES,
  FILLS,
  fromItemId,
  type Dash,
  type Fill,
  type Item,
} from "./model";
import { colorHex } from "./palette";
import { useCanvasScheme } from "./scheme";
import { updateItems } from "./store";

/**
 * 样式条（React Flow 计划 F28，归属 whiteboard）。
 *
 * 一个条两种作用对象：**没选中东西时**改「下一个画出来的对象」
 * （`tool-store.nextStyle`），**选中了白板对象时**改选中的那些
 * （`whiteboard.updateItems`）。显隐规则是 `tools.shouldShowStylePanel`，
 * 纯函数且已有单测。
 *
 * 位置固定在底部 Dock 正上方居中（`styles/canvas.css` 的 `.canvas-style-row`），
 * 与 Dock 同一套面材与圆角；以前悬在左侧垂直居中、184px 宽的一整块，颜色
 * 网格与带标题的分组把画布盖掉一大片（#714）。现在是单行：颜色收进一个色点
 * 触发的 Popover，其余都是不带可见标题的 `ToggleGroup`（名称在 `aria-label`
 * 与提示里），组间一条竖线。
 *
 * 只有当前选区真的用得上的那几组会显示：选中一条墨迹时不该出现「填充」，
 * 选中一条直线时不该出现「对齐」。条越短，判断「我在改什么」越快。
 */

const SIZE_LABELS: Record<WhiteboardSize, string> = {
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

/** 粗细档的预览线宽（画在 16px 的图标里）；类名要写全，Tailwind 才扫得到。 */
const SIZE_STROKES: Record<WhiteboardSize, string> = {
  s: "stroke-[1.5px]",
  m: "stroke-[2.5px]",
  l: "stroke-[3.5px]",
  xl: "stroke-[5px]",
};

const DASH_LABEL_KEYS: Record<Dash, string> = {
  solid: "style.dash.solid",
  dashed: "style.dash.dashed",
  dotted: "style.dash.dotted",
};

const FILL_LABEL_KEYS: Record<Fill, string> = {
  none: "style.fill.none",
  semi: "style.fill.semi",
  solid: "style.fill.solid",
};

/** 选区里出现了哪些类型，决定显示哪几组控件。 */
function sectionsFor(items: readonly Item[]): {
  dash: boolean;
  fill: boolean;
  arrow: boolean;
  align: boolean;
} {
  if (items.length === 0)
    return { dash: true, fill: true, arrow: false, align: false };
  const kinds = new Set(items.map((item) => item.kind));
  return {
    dash: kinds.has("shape") || kinds.has("line"),
    fill: kinds.has("shape"),
    arrow: kinds.has("line"),
    align: kinds.has("text"),
  };
}

export function CanvasStylePanel() {
  const t = useT();
  const tool = useTool();
  const scheme = useCanvasScheme();
  const next = useNextStyle();
  const focusMode = usePreferencesStore((state) => state.whiteboard.focus);
  const selectedIds = useCanvasStore((state) => state.selectedItemIds);
  // 也要订阅 `items`：只盯选区的话，改完颜色再改粗细时读到的是改颜色**之前**
  // 那一份，第二次改会把第一次的颜色写回去。
  const allItems = useCanvasStore((state) => state.whiteboard.items);
  const items = React.useMemo(() => {
    const wanted = new Set(selectedIds.map(fromItemId));
    return allItems.filter((item) => wanted.has(item.id));
  }, [allItems, selectedIds]);

  if (focusMode || !shouldShowStylePanel(tool, selectedIds, items)) return null;

  const sections = sectionsFor(items);
  const current = items[0]?.style;
  const color = current?.color ?? next.color;
  const size = current?.size ?? next.size;
  const dash = current?.dash ?? next.dash;
  const fill = current?.fill ?? next.fill;
  const align = current?.align ?? "start";
  const arrowEnd = items.every(
    (item) => item.kind !== "line" || item.arrowEnd === true,
  );
  const arrowStart = items.some(
    (item) => item.kind === "line" && item.arrowStart === true,
  );

  /** 有选区就改选区，没有就改「下一个」。 */
  const applyStyle = (patch: Record<string, unknown>) => {
    if (items.length > 0) {
      updateItems(
        items.map((item) => ({
          id: item.id,
          patch: { style: { ...item.style, ...patch } } as Partial<Item>,
        })),
      );
      return;
    }
    setNextStyle(patch as never);
  };

  const applyArrow = (patch: { arrowStart?: boolean; arrowEnd?: boolean }) => {
    updateItems(
      items
        .filter((item) => item.kind === "line")
        .map((item) => ({ id: item.id, patch: patch as Partial<Item> })),
    );
  };

  const groups: React.ReactNode[] = [
    <ColorPicker
      key="color"
      color={color}
      scheme={scheme}
      onChange={(value) => applyStyle({ color: value })}
    />,
    <StyleGroup
      key="size"
      label={t("style.size")}
      value={size}
      onChange={(value) => applyStyle({ size: value as WhiteboardSize })}
      options={WHITEBOARD_SIZES.map((option) => ({
        value: option,
        label: <SizePreview stroke={SIZE_STROKES[option]} />,
        title: `${t("style.size")} ${SIZE_LABELS[option]}`,
      }))}
    />,
  ];

  if (sections.dash) {
    groups.push(
      <StyleGroup
        key="dash"
        label={t("style.dash")}
        value={dash}
        onChange={(value) => applyStyle({ dash: value as Dash })}
        options={DASHES.map((option) => ({
          value: option,
          label: <DashPreview dash={option} />,
          title: t(DASH_LABEL_KEYS[option]),
        }))}
      />,
    );
  }
  if (sections.fill) {
    groups.push(
      <StyleGroup
        key="fill"
        label={t("style.fill")}
        value={fill}
        onChange={(value) => applyStyle({ fill: value as Fill })}
        options={FILLS.map((option) => ({
          value: option,
          label: <FillPreview fill={option} />,
          title: t(FILL_LABEL_KEYS[option]),
        }))}
      />,
    );
  }
  if (sections.align) {
    groups.push(
      <StyleGroup
        key="align"
        label={t("style.align")}
        value={align}
        onChange={(value) => applyStyle({ align: value })}
        options={[
          {
            value: "start",
            label: <AlignLeft />,
            title: t("style.align.start"),
          },
          {
            value: "middle",
            label: <AlignCenter />,
            title: t("style.align.middle"),
          },
          {
            value: "end",
            label: <AlignRight />,
            title: t("style.align.end"),
          },
        ]}
      />,
    );
  }
  if (sections.arrow) {
    groups.push(
      <StyleGroup
        key="arrow"
        multiple
        label={t("style.arrow")}
        value={[arrowStart ? "start" : "", arrowEnd ? "end" : ""].filter(
          Boolean,
        )}
        onChange={(value) =>
          applyArrow({
            arrowStart: value.includes("start"),
            arrowEnd: value.includes("end"),
          })
        }
        options={[
          {
            value: "start",
            label: <ArrowLeft />,
            title: t("style.arrow.start"),
          },
          { value: "end", label: <ArrowRight />, title: t("style.arrow.end") },
        ]}
      />,
    );
  }

  // 位置在 `.canvas-style-row`：Dock 正上方居中。整行不接指针，只有条本身接。
  return (
    <div className="canvas-style-row">
      <div
        role="toolbar"
        data-slot="style-panel"
        aria-label={t("style.panel")}
        className="canvas-style-panel flex max-w-full items-center gap-1 overflow-x-auto rounded-panel border border-border-strong bg-panel/90 px-1.5 py-1 shadow-overlay backdrop-blur-[12px]"
      >
        {groups.flatMap((group, index) =>
          index === 0
            ? [group]
            : [
                <Separator
                  key={`separator-${index}`}
                  orientation="vertical"
                  className="mx-0.5 h-4"
                />,
                group,
              ],
        )}
      </div>
    </div>
  );
}

/** 当前颜色的色点；点开是一块色板，选一个就关。 */
function ColorPicker({
  color,
  scheme,
  onChange,
}: {
  color: WhiteboardColor;
  scheme: ReturnType<typeof useCanvasScheme>;
  onChange: (color: WhiteboardColor) => void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <IconButton size="cluster" label={t("style.color")} active={open}>
              <ColorDot
                color={colorHex(color, scheme)}
                size={14}
                className="border border-border-strong"
              />
            </IconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("style.color")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-auto max-w-none gap-0 p-1.5"
      >
        <div
          role="radiogroup"
          aria-label={t("style.color")}
          className="grid grid-cols-7 gap-0.5"
        >
          {WHITEBOARD_COLORS.map((option) => (
            <ColorButton
              key={option}
              color={option}
              hex={colorHex(option, scheme)}
              selected={color === option}
              onSelect={() => {
                onChange(option);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ColorButton({
  color,
  hex,
  selected,
  onSelect,
}: {
  color: WhiteboardColor;
  hex: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const label = t(`settings.whiteboard.color.${color}`);
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          role="radio"
          aria-checked={selected}
          aria-label={label}
          onClick={onSelect}
        >
          <ColorDot
            color={hex}
            size={14}
            selected={selected}
            className="border border-border"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface StyleGroupOption {
  value: string;
  label: React.ReactNode;
  title: string;
}

type StyleGroupProps = {
  label: string;
  options: StyleGroupOption[];
} & (
  | {
      multiple?: false;
      value: string;
      onChange: (value: string) => void;
    }
  | {
      multiple: true;
      value: string[];
      onChange: (value: string[]) => void;
    }
);

/**
 * 选中项与 `IconButton active` 同一套：`--brand-soft` 底 + 标题墨色。
 *
 * 认 `aria-checked`（单选）与 `aria-pressed`（多选），不认 `data-state`：
 * 外面套着 `TooltipTrigger asChild`，它会把同一个元素的 `data-state` 改写成
 * `closed` / `delayed-open`，Radix 写的 `on` 到不了 DOM。
 */
const ITEM_CLASS =
  "w-7 px-0 text-muted-foreground aria-checked:bg-brand-soft aria-checked:text-strong aria-pressed:bg-brand-soft aria-pressed:text-strong";

/**
 * 没有可见标题：名称在组的 `aria-label` 与每一项的提示里。四档粗细、三档
 * 线型都用图形而不是字母，中英文界面长得一样。
 */
function StyleGroup(props: StyleGroupProps) {
  const { label, options } = props;
  const items = options.map((option) => (
    <Tooltip key={option.value} delayDuration={500}>
      <TooltipTrigger asChild>
        <ToggleGroupItem
          value={option.value}
          aria-label={option.title}
          className={cn(ITEM_CLASS)}
        >
          {option.label}
        </ToggleGroupItem>
      </TooltipTrigger>
      <TooltipContent>{option.title}</TooltipContent>
    </Tooltip>
  ));
  if (props.multiple) {
    return (
      <ToggleGroup
        type="multiple"
        size="sm"
        spacing={0.5}
        value={props.value}
        aria-label={label}
        onValueChange={props.onChange}
      >
        {items}
      </ToggleGroup>
    );
  }
  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={0.5}
      value={props.value}
      aria-label={label}
      onValueChange={(next) => {
        if (next) props.onChange(next);
      }}
    >
      {items}
    </ToggleGroup>
  );
}

function SizePreview({ stroke }: { stroke: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <line
        x1={2.5}
        y1={8}
        x2={13.5}
        y2={8}
        stroke="currentColor"
        className={stroke}
        strokeLinecap="round"
      />
    </svg>
  );
}

function DashPreview({ dash }: { dash: Dash }) {
  if (dash === "solid") return <Minus />;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <line
        x1={2}
        y1={8}
        x2={14}
        y2={8}
        stroke="currentColor"
        className="stroke-2"
        strokeLinecap="round"
        strokeDasharray={dash === "dashed" ? "4 3" : "0.5 3"}
      />
    </svg>
  );
}

function FillPreview({ fill }: { fill: Fill }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <rect
        x={2.5}
        y={2.5}
        width={11}
        height={11}
        rx={2}
        stroke="currentColor"
        className="stroke-[1.5px]"
        fill="currentColor"
        fillOpacity={fill === "solid" ? 1 : fill === "semi" ? 0.3 : 0}
      />
    </svg>
  );
}
