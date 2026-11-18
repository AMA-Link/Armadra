import * as React from "react";
import {
  Check,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Lock,
  type LucideIcon,
  PenLine,
  Search,
  ShieldOff,
  Zap,
} from "lucide-react";
import type {
  AcpModeState,
  AcpModelState,
  TimelineConfigOption,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { isMacPlatform } from "@/keybindings/chords";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { Kbd } from "@/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Switch } from "@/ui/switch";
import {
  isFastSpeed,
  type ModeKind,
  modeKindOf,
  splitPopoverOptions,
} from "./pickers";

/** select 当前值的名字（不在列表里时用值本身）。 */
export function configValueName(option: TimelineConfigOption): string {
  if (option.type === "boolean") return option.name;
  return (
    option.options.find((choice) => choice.value === option.currentValue)
      ?.name ?? String(option.currentValue)
  );
}

/** 思考强度当前值的名字：select 是选中项，boolean 打开时是项名，关着不显示。 */
export function effortValueName(option: TimelineConfigOption): string | null {
  if (option.type === "boolean")
    return option.currentValue === true ? option.name : null;
  return (
    option.options.find((choice) => choice.value === option.currentValue)
      ?.name ?? null
  );
}

/** 列表前几项带 ⌘1…⌘9（其他平台 Ctrl+1…）。 */
export const JUMP_KEYS = 9;

const MODE_ICONS: Record<ModeKind, LucideIcon> = {
  ask: Lock,
  edits: PenLine,
  full: ShieldOff,
  plan: ClipboardList,
};

/** 分段图标最多这么多个、且互不重复，才画成一排图标；否则是带名字的列表。 */
const MODE_SEGMENTS_MAX = 5;

/** 操作行上的触发器：无边、无底，悬停才出底色。 */
const QUIET_TRIGGER =
  "min-w-0 shrink-0 gap-1.5 px-2 font-normal text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground";

/** 右栏一行：与左栏的模型行同高，第一行与第一个模型对齐。 */
const COLUMN_ROW =
  "h-8 w-full shrink-0 cursor-pointer justify-start gap-2 rounded-tight px-2 text-left font-normal text-foreground focus-visible:bg-hover";

/** 底栏分段里的一格。 */
const SEGMENT =
  "cursor-pointer gap-1 rounded-tight px-2 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-checked:bg-input data-checked:text-foreground data-checked:hover:bg-input";

function FastBolt() {
  return (
    <Zap
      aria-hidden
      data-slot="acp-fast-bolt"
      className="size-3 shrink-0 fill-current"
    />
  );
}

/** 列里按 ↑ ↓ 在可用的行之间移动。 */
function moveBetweenRows(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (!event.currentTarget.contains(event.target as Node)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      "[data-column-row]:not(:disabled)",
    ),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next =
    rows[
      Math.min(
        rows.length - 1,
        Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
      )
    ];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

/** 左栏：搜索 + 模型列表。 */
function ModelColumn({
  models,
  onPick,
  onFocusColumn,
  searchRef,
  compact,
}: {
  models: AcpModelState;
  onPick: (modelId: string) => void;
  /** → 键：把焦点交给右栏。 */
  onFocusColumn: (() => void) | null;
  searchRef: React.RefObject<HTMLInputElement | null>;
  compact: boolean;
}) {
  const t = useT();
  const mac = React.useMemo(() => isMacPlatform(), []);
  const [query, setQuery] = React.useState("");
  const listId = React.useId();
  const shown = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return models.availableModels;
    return models.availableModels.filter(
      (model) =>
        model.name.toLowerCase().includes(needle) ||
        model.modelId.toLowerCase().includes(needle),
    );
  }, [models.availableModels, query]);
  const [highlight, setHighlight] = React.useState(0);
  React.useEffect(() => {
    const current = shown.findIndex(
      (model) => model.modelId === models.currentModelId,
    );
    setHighlight(query === "" && current >= 0 ? current : 0);
  }, [shown, query, models.currentModelId]);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 只接冒泡上来的 ⌘1…⌘9，交互在里面的搜索框与选项上
    <div
      data-slot="acp-model-column"
      className={cn(
        "flex min-h-0 flex-col",
        compact ? "h-56 w-full" : "w-72 shrink-0",
      )}
      onKeyDown={(event) => {
        // ⌘1…⌘9：直接选第 N 个（按当前筛选后的顺序）。
        const mod = mac ? event.metaKey : event.ctrlKey;
        if (!mod || event.altKey || event.shiftKey) return;
        const n = Number(event.key);
        if (!Number.isInteger(n) || n < 1 || n > JUMP_KEYS) return;
        const model = shown[n - 1];
        if (!model) return;
        event.preventDefault();
        event.stopPropagation();
        onPick(model.modelId);
      }}
    >
      <div className="shrink-0 px-3 pt-2.5">
        <div className="relative border-b border-border pb-1.5 transition-colors focus-within:border-ring">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1.5 left-0 size-4 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="text"
            size="xs"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-label={t("acp.prompt.search")}
            aria-activedescendant={
              shown[highlight] ? `${listId}-${highlight}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            data-slot="acp-model-search"
            placeholder={t("acp.prompt.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (shown.length === 0) return;
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight(
                  (index) => (index + step + shown.length) % shown.length,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const model = shown[highlight];
                if (model) onPick(model.modelId);
                return;
              }
              if (
                event.key === "ArrowRight" &&
                onFocusColumn &&
                event.currentTarget.selectionStart === query.length
              ) {
                event.preventDefault();
                onFocusColumn();
              }
            }}
            className="h-6.5 rounded-none border-0 bg-transparent py-0 ps-6 pe-0 text-body focus-visible:ring-0 desktop:text-body"
          />
        </div>
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("acp.prompt.modelList")}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2.5 pb-1.5"
      >
        {shown.length === 0 && (
          <div className="flex h-8 items-center px-2 text-body text-muted-foreground">
            {t("acp.prompt.noModels")}
          </div>
        )}
        {shown.map((model, index) => {
          const selected = model.modelId === models.currentModelId;
          return (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- 焦点留在搜索框（aria-activedescendant），↑ ↓ 与 Enter 在搜索框上处理
            <div
              key={model.modelId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={selected}
              data-index={index}
              data-highlighted={index === highlight || undefined}
              data-slot="acp-model-option"
              title={model.description ?? undefined}
              className="group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-tight px-2 text-body text-foreground select-none hover:bg-hover data-highlighted:bg-hover"
              onPointerMove={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(model.modelId)}
            >
              <span className="min-w-0 truncate">{model.name}</span>
              {selected && <Check aria-hidden className="size-3.5 shrink-0" />}
              {index < JUMP_KEYS && (
                <Kbd aria-hidden className="ml-auto shrink-0">
                  {mac ? `⌘${index + 1}` : `Ctrl+${index + 1}`}
                </Kbd>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 右栏的一行选项：选中打勾。 */
function ColumnRow({
  label,
  selected,
  tabStop,
  description,
  onPick,
}: {
  label: string;
  selected: boolean;
  tabStop: boolean;
  description?: string | null | undefined;
  onPick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      role="radio"
      aria-checked={selected}
      data-column-row
      data-effort-level
      tabIndex={tabStop ? 0 : -1}
      title={description ?? undefined}
      className={COLUMN_ROW}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check aria-hidden className="size-3.5 shrink-0" />}
    </Button>
  );
}

/** 一项的名字在上、当前值在下。 */
function OptionRowText({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-caption text-muted-foreground">
        {label}
      </span>
      <span className="truncate">{value}</span>
    </span>
  );
}

/** 思考强度以外的一个 select：一行写当前值，→ 或点开在栏旁展开。 */
function OptionMenuRow({
  option,
  onConfig,
  tabStop,
}: {
  option: TimelineConfigOption;
  onConfig: (configId: string, value: string | boolean) => void;
  tabStop: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const current = configValueName(option);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-column-row
          data-slot="acp-config-select"
          tabIndex={tabStop ? 0 : -1}
          aria-label={`${option.name}: ${current}`}
          className={cn(COLUMN_ROW, "h-auto py-1 data-[state=open]:bg-hover")}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <OptionRowText label={option.name} value={current} />
          <ChevronRight
            aria-hidden
            className="-me-1 size-3.5 shrink-0 text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={6}
        className="w-auto max-w-72"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          setOpen(false);
        }}
      >
        <DropdownMenuRadioGroup
          aria-label={option.name}
          value={String(option.currentValue)}
          onValueChange={(value) => {
            if (value !== option.currentValue) onConfig(option.id, value);
          }}
        >
          {option.options.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{choice.name}</span>
                {choice.description && (
                  <span className="line-clamp-2 text-caption text-muted-foreground">
                    {choice.description}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 两态的项就地切换：开关比菜单少一次点击。 */
function OptionSwitchRow({
  option,
  onConfig,
  tabStop,
}: {
  option: TimelineConfigOption;
  onConfig: (configId: string, value: string | boolean) => void;
  tabStop: boolean;
}) {
  const t = useT();
  const checked = option.currentValue === true;
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- 开关就在标签里面，点整行切换
    <label
      data-slot="acp-config-toggle"
      className={cn(COLUMN_ROW, "h-auto py-1 has-focus-visible:bg-hover")}
    >
      <OptionRowText
        label={option.name}
        value={checked ? t("acp.prompt.on") : t("acp.prompt.off")}
      />
      <Switch
        size="sm"
        checked={checked}
        aria-label={option.name}
        data-column-row
        tabIndex={tabStop ? 0 : -1}
        onCheckedChange={(next) => onConfig(option.id, next)}
      />
    </label>
  );
}

/** 右栏：表头写「思考强度」与模型名，下面是强度，分隔线下是其余配置项。 */
function EffortColumn({
  effort,
  rest,
  onConfig,
  modelName,
  hasModels,
  compact,
}: {
  effort: TimelineConfigOption | null;
  rest: readonly TimelineConfigOption[];
  onConfig: (configId: string, value: string | boolean) => void;
  modelName: string | null;
  hasModels: boolean;
  compact: boolean;
}) {
  const t = useT();
  const heading =
    effort !== null
      ? t("acp.prompt.effort")
      : rest.length > 0
        ? t("acp.prompt.options")
        : t("acp.prompt.effort");
  const effortValue = effort === null ? null : String(effort.currentValue);
  const shown =
    effort?.type === "select" &&
    effort.options.some((choice) => choice.value === effortValue);
  return (
    <div
      data-slot="acp-effort-column"
      className={cn(
        "flex min-h-0 flex-col",
        hasModels &&
          (compact ? "border-t border-border" : "border-l border-border"),
        compact ? "max-h-64 w-full" : hasModels ? "w-48 shrink-0" : "w-56",
      )}
    >
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8.25 items-center gap-2 border-b border-border pb-1.5 text-body">
          <span className="shrink-0 text-muted-foreground">{heading}</span>
          {modelName !== null && (
            <span className="ms-auto min-w-0 truncate text-caption text-muted-foreground">
              {modelName}
            </span>
          )}
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2.5 pb-1.5"
        onKeyDownCapture={moveBetweenRows}
      >
        {effort === null && rest.length === 0 && (
          <div className="flex h-8 items-center px-2 text-body text-muted-foreground">
            {t("acp.prompt.noEffort")}
          </div>
        )}
        {effort !== null && (
          <div
            role="radiogroup"
            aria-label={effort.name}
            className="flex flex-col gap-0.5"
          >
            {effort.type === "boolean"
              ? ([true, false] as const).map((value) => (
                  <ColumnRow
                    key={String(value)}
                    label={value ? t("acp.prompt.on") : t("acp.prompt.off")}
                    selected={(effort.currentValue === true) === value}
                    tabStop={(effort.currentValue === true) === value}
                    onPick={() => onConfig(effort.id, value)}
                  />
                ))
              : effort.options.map((choice, index) => (
                  <ColumnRow
                    key={choice.value}
                    label={choice.name}
                    description={choice.description}
                    selected={choice.value === effortValue}
                    tabStop={shown ? choice.value === effortValue : index === 0}
                    onPick={() => {
                      if (choice.value !== effortValue)
                        onConfig(effort.id, choice.value);
                    }}
                  />
                ))}
          </div>
        )}
        {rest.length > 0 && (
          <div
            className={cn(
              "flex flex-col gap-0.5",
              effort !== null && "mt-1 border-t border-border pt-1",
            )}
          >
            {rest.map((option, index) =>
              option.type === "boolean" ? (
                <OptionSwitchRow
                  key={option.id}
                  option={option}
                  onConfig={onConfig}
                  tabStop={effort === null && index === 0}
                />
              ) : (
                <OptionMenuRow
                  key={option.id}
                  option={option}
                  onConfig={onConfig}
                  tabStop={effort === null && index === 0}
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 底栏左边：「标准 / ⚡ 快速」，或 Agent 报的服务档位。 */
function SpeedControl({
  option,
  onConfig,
}: {
  option: TimelineConfigOption;
  onConfig: (configId: string, value: string | boolean) => void;
}) {
  const t = useT();
  const segments =
    option.type === "boolean"
      ? ([false, true] as const).map((value) => ({
          key: String(value),
          label: value
            ? t("acp.prompt.speed.fast")
            : t("acp.prompt.speed.standard"),
          fast: value,
          checked: (option.currentValue === true) === value,
          description: null as string | null | undefined,
          pick: () => onConfig(option.id, value),
        }))
      : option.options.map((choice) => ({
          key: choice.value,
          label: choice.name,
          fast: /fast/i.test(`${choice.value} ${choice.name}`),
          checked: choice.value === option.currentValue,
          description: choice.description,
          pick: () => onConfig(option.id, choice.value),
        }));
  return (
    <div
      role="radiogroup"
      aria-label={option.name}
      data-slot="acp-speed"
      className="flex rounded-control bg-input/40 p-0.5"
    >
      {segments.map((segment) => (
        <Button
          key={segment.key}
          variant="ghost"
          size="xs"
          role="radio"
          aria-checked={segment.checked}
          data-checked={segment.checked || undefined}
          title={segment.description ?? undefined}
          className={SEGMENT}
          onClick={() => {
            if (!segment.checked) segment.pick();
          }}
        >
          {segment.fast && <FastBolt />}
          {segment.label}
        </Button>
      ))}
    </div>
  );
}

/** 底栏右边：权限模式。少改，所以按钮只写当前模式，选择收在一层菜单里。 */
function PermissionsMenu({
  modes,
  onMode,
}: {
  modes: AcpModeState;
  onMode: (modeId: string) => void;
}) {
  const t = useT();
  const [preview, setPreview] = React.useState<string | null>(null);
  const current = modes.availableModes.find(
    (mode) => mode.id === modes.currentModeId,
  );
  const shownMode =
    modes.availableModes.find((mode) => mode.id === preview) ?? current;
  const CurrentIcon = MODE_ICONS[modeKindOf(modes.currentModeId)];
  const kinds = modes.availableModes.map((mode) => modeKindOf(mode.id));
  const segmented =
    modes.availableModes.length <= MODE_SEGMENTS_MAX &&
    new Set(kinds).size === kinds.length;
  return (
    <DropdownMenu onOpenChange={(open) => !open && setPreview(null)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-slot="acp-permissions"
          aria-label={`${t("acp.prompt.permissions")}: ${current?.name ?? modes.currentModeId}`}
          className="ms-auto min-w-0 shrink gap-1.5 px-2 text-meta font-normal text-muted-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground"
        >
          <CurrentIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {current?.name ?? modes.currentModeId}
          </span>
          <ChevronUp aria-hidden className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        className={cn("w-72", segmented && "p-0")}
      >
        {segmented ? (
          <div
            data-slot="acp-permissions-section"
            className="grid gap-1.5 px-2 py-1.5"
          >
            <DropdownMenuLabel className="p-0 text-caption font-medium text-muted-foreground">
              {t("acp.prompt.permissions")}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={modes.currentModeId}
              onValueChange={(value) => {
                if (value !== modes.currentModeId) onMode(value);
              }}
              className="flex rounded-control bg-input/40 p-0.5"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="menuitemradio"]',
                  ),
                );
                const index = items.findIndex(
                  (item) => item === document.activeElement,
                );
                const next =
                  items[index + (event.key === "ArrowRight" ? 1 : -1)];
                if (index < 0 || !next) return;
                event.preventDefault();
                event.stopPropagation();
                next.focus();
              }}
            >
              {modes.availableModes.map((mode) => {
                const Icon = MODE_ICONS[modeKindOf(mode.id)];
                return (
                  <DropdownMenuRadioItem
                    key={mode.id}
                    value={mode.id}
                    aria-label={mode.name}
                    onPointerEnter={() => setPreview(mode.id)}
                    onPointerLeave={() => setPreview(null)}
                    onFocus={() => setPreview(mode.id)}
                    onBlur={() => setPreview(null)}
                    className="flex flex-1 cursor-pointer items-center justify-center rounded-tight px-0 py-1 text-muted-foreground focus:bg-accent data-[state=checked]:bg-input data-[state=checked]:text-foreground *:data-[slot=dropdown-menu-radio-item-indicator]:hidden"
                  >
                    <Icon aria-hidden className="size-3.5" />
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            <div aria-hidden className="grid gap-0.5 pt-0.5">
              <div className="text-body text-foreground">{shownMode?.name}</div>
              {shownMode?.description && (
                <div className="text-caption text-muted-foreground">
                  {shownMode.description}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <DropdownMenuLabel>{t("acp.prompt.permissions")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={modes.currentModeId}
              onValueChange={(value) => {
                if (value !== modes.currentModeId) onMode(value);
              }}
            >
              {modes.availableModes.map((mode) => {
                const Icon = MODE_ICONS[modeKindOf(mode.id)];
                return (
                  <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                    <Icon
                      aria-hidden
                      className="size-3.5 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{mode.name}</span>
                      {mode.description && (
                        <span className="line-clamp-2 text-caption text-muted-foreground">
                          {mode.description}
                        </span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 模型按钮与它的弹层（#970）。操作行上只有这一个控件，写「模型 强度 ⚡」；点开是
 * 一块固定高度的弹层：左栏搜索与模型（前九项 ⌘1…⌘9），右栏是该模型的思考强度，
 * 分隔线下是 Agent 报的其余配置项；底栏左边是速度（「标准 / 快速」），右边是权限
 * 模式。选了模型弹层不关，焦点移到强度，接着就能选；Esc 或点外面收起。窄屏两栏上下排。
 * 哪一块都没有可选的就不画那一块；什么都没有时不画按钮。
 */
export function ModelPopover({
  models,
  onModel,
  modes,
  onMode,
  options,
  onConfig,
  disabled,
  compact,
}: {
  models: AcpModelState | null;
  onModel?: ((modelId: string) => void) | undefined;
  modes: AcpModeState | null;
  onMode: (modeId: string) => void;
  options: readonly TimelineConfigOption[];
  onConfig?: ((configId: string, value: string | boolean) => void) | undefined;
  disabled: boolean;
  compact: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);
  const modelChoice =
    models && onModel && models.availableModels.length > 0 ? models : null;
  const { effort, speed, rest } = onConfig
    ? splitPopoverOptions(options)
    : { effort: null, speed: null, rest: [] };
  const modeChoice = modes && modes.availableModes.length > 1 ? modes : null;
  if (
    modelChoice === null &&
    effort === null &&
    speed === null &&
    rest.length === 0 &&
    modeChoice === null
  )
    return null;

  const model = modelChoice?.availableModels.find(
    (entry) => entry.modelId === modelChoice.currentModelId,
  );
  const effortName = effort ? effortValueName(effort) : null;
  const fast = speed !== null && isFastSpeed(speed);
  const modeName =
    modeChoice?.availableModes.find(
      (mode) => mode.id === modeChoice.currentModeId,
    )?.name ?? null;
  const triggerName = model?.name ?? (effortName === null ? modeName : null);
  const label =
    modelChoice !== null ? t("acp.prompt.model") : t("acp.prompt.effort");
  const showColumn = modelChoice !== null || effort !== null || rest.length > 0;

  /** 焦点交给右栏：选中的强度，否则第一个能聚焦的行。 */
  const focusColumn = () => {
    const column = columnRef.current;
    const row =
      column?.querySelector<HTMLElement>(
        '[data-effort-level][aria-checked="true"]:not(:disabled)',
      ) ??
      column?.querySelector<HTMLElement>("[data-column-row]:not(:disabled)");
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };

  const pickModel = (modelId: string) => {
    if (modelId !== modelChoice?.currentModelId) onModel?.(modelId);
    // 还有强度或配置项要选：弹层留着，焦点交给右栏；否则收起。
    if (effort !== null || rest.length > 0) {
      requestAnimationFrame(focusColumn);
      return;
    }
    setOpen(false);
  };

  const footer = (speed !== null && onConfig) || modeChoice !== null;

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          title={
            [model?.name, effortName].filter(Boolean).join(" · ") || undefined
          }
          data-slot="acp-model-effort"
          disabled={disabled}
          className={cn(QUIET_TRIGGER, compact ? "max-w-44" : "max-w-64")}
        >
          {triggerName !== null && (
            <span className="min-w-0 truncate text-foreground">
              {triggerName}
            </span>
          )}
          {effortName !== null && (
            <span
              data-slot="acp-effort-value"
              className="max-w-24 min-w-0 shrink-[2] truncate"
            >
              {effortName}
            </span>
          )}
          {fast && <FastBolt />}
          {triggerName === null && effortName === null && (
            <span className="min-w-0 truncate">{label}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        data-slot="acp-model-popover"
        className={cn(
          "max-w-none gap-0 overflow-hidden p-0",
          compact ? "w-[min(24rem,calc(100vw-1rem))]" : "w-auto",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (searchRef.current) searchRef.current.focus();
          else focusColumn();
        }}
      >
        <div className="flex max-h-(--radix-popover-content-available-height) min-h-0 flex-col bg-muted/40">
          <div
            className={cn(
              "flex min-h-0",
              compact
                ? "flex-col"
                : modelChoice !== null
                  ? "h-86.5"
                  : "max-h-86.5",
            )}
          >
            {modelChoice !== null && (
              <ModelColumn
                models={modelChoice}
                onPick={pickModel}
                onFocusColumn={showColumn ? focusColumn : null}
                searchRef={searchRef}
                compact={compact}
              />
            )}
            {showColumn && (
              // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 只接冒泡上来的 ←，把焦点交回搜索框
              <div
                ref={columnRef}
                className="contents"
                onKeyDown={(event) => {
                  if (
                    event.key !== "ArrowLeft" ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    !searchRef.current
                  )
                    return;
                  // 子菜单里的 ← 归子菜单。
                  if (!event.currentTarget.contains(event.target as Node))
                    return;
                  event.preventDefault();
                  searchRef.current.focus();
                }}
              >
                <EffortColumn
                  effort={effort}
                  rest={rest}
                  onConfig={onConfig ?? (() => undefined)}
                  modelName={model?.name ?? null}
                  hasModels={modelChoice !== null}
                  compact={compact}
                />
              </div>
            )}
          </div>
          {footer && (
            <div
              data-slot="acp-model-footer"
              className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2"
            >
              {speed !== null && onConfig && (
                <SpeedControl option={speed} onConfig={onConfig} />
              )}
              {modeChoice !== null && (
                <PermissionsMenu modes={modeChoice} onMode={onMode} />
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
