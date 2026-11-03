import { ChevronDown } from "lucide-react";
import type {
  AcpModeState,
  AcpModelState,
  TimelineConfigOption,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { Toggle } from "@/ui/toggle";

/** 模式不超过这么多个、名字不超过这么多字，才画成分段控件。 */
export const SEGMENTED_MODES_MAX = 3;
export const SEGMENTED_NAME_MAX = 10;

/**
 * 操作行上的下拉：无边、无底，悬停才出底色，与图标按钮同高。每个控件都不收缩
 * （`shrink-0`）、各自有宽度上限并在里面截断：放不下时整段横向滚动，而不是把
 * 相邻两个控件挤成一串连在一起的字（#768）。
 */
const QUIET_TRIGGER =
  "min-w-0 shrink-0 border-transparent bg-transparent font-normal text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground";

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

/**
 * 模式：少而短时是分段控件，否则（或窄屏）是下拉。只有一个模式时不画。
 */
export function ModePicker({
  modes,
  onMode,
  disabled,
  compact,
}: {
  modes: AcpModeState;
  onMode: (modeId: string) => void;
  disabled: boolean;
  compact: boolean;
}) {
  const t = useT();
  const segmented =
    !compact &&
    modes.availableModes.length <= SEGMENTED_MODES_MAX &&
    modes.availableModes.every(
      (mode) => mode.name.length <= SEGMENTED_NAME_MAX,
    );
  if (segmented) {
    return (
      <Tabs value={modes.currentModeId} onValueChange={onMode}>
        <TabsList
          variant="segmented"
          size="sm"
          aria-label={t("acp.prompt.mode")}
        >
          {modes.availableModes.map((mode) => (
            <TabsTrigger key={mode.id} value={mode.id} disabled={disabled}>
              {mode.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    );
  }
  return (
    <Select
      value={modes.currentModeId}
      disabled={disabled}
      onValueChange={onMode}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("acp.prompt.mode")}
        title={
          modes.availableModes.find((mode) => mode.id === modes.currentModeId)
            ?.name
        }
        className={cn(QUIET_TRIGGER, compact ? "max-w-32" : "max-w-44")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {modes.availableModes.map((mode) => (
          <SelectItem key={mode.id} value={mode.id}>
            {mode.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * 模型与思考强度合在一个控件里：触发器是「模型 · 强度」，菜单上半是模型、下半是
 * 强度。有强度可选时点模型不关菜单，接着就能选它的强度；Agent 换模型后若强度的
 * 可选值变了，下半随头部里的配置项一起变。只有强度、没有模型目录时只显示强度。
 */
export function ModelEffortPicker({
  models,
  onModel,
  effort,
  onConfig,
  disabled,
  compact,
}: {
  models: AcpModelState | null;
  onModel?: ((modelId: string) => void) | undefined;
  effort: TimelineConfigOption | null;
  onConfig?: ((configId: string, value: string | boolean) => void) | undefined;
  disabled: boolean;
  compact: boolean;
}) {
  const t = useT();
  const modelChoice = models && onModel ? models : null;
  const effortChoice = effort && onConfig ? effort : null;
  if (modelChoice === null && effortChoice === null) return null;
  const model = modelChoice?.availableModels.find(
    (entry) => entry.modelId === modelChoice.currentModelId,
  );
  const effortName = effortChoice ? effortValueName(effortChoice) : null;
  const label =
    modelChoice !== null ? t("acp.prompt.model") : t("acp.prompt.effort");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          title={
            [model?.name, effortName].filter(Boolean).join(" · ") || undefined
          }
          data-slot="acp-model-effort"
          disabled={disabled}
          className={cn(
            QUIET_TRIGGER,
            "gap-1 px-2",
            compact ? "max-w-40" : "max-w-60",
          )}
        >
          {model !== undefined && (
            <span className="min-w-0 truncate">{model.name}</span>
          )}
          {effortName !== null && (
            <span
              data-slot="acp-effort-value"
              className="min-w-0 shrink-[2] truncate text-muted-foreground"
            >
              {model !== undefined && (
                <span aria-hidden className="pr-1">
                  ·
                </span>
              )}
              {effortName}
            </span>
          )}
          {model === undefined && effortName === null && (
            <span className="min-w-0 truncate">{t("acp.prompt.effort")}</span>
          )}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-[60dvh] max-w-72 min-w-52 overflow-y-auto"
      >
        {modelChoice !== null && (
          <>
            <DropdownMenuLabel>{t("acp.prompt.model")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={modelChoice.currentModelId}
              onValueChange={(id) => onModel?.(id)}
            >
              {modelChoice.availableModels.map((entry) => (
                <DropdownMenuRadioItem
                  key={entry.modelId}
                  value={entry.modelId}
                  // 还要选强度：菜单留着。
                  onSelect={(event) => {
                    if (effortChoice !== null) event.preventDefault();
                  }}
                >
                  <span className="min-w-0 truncate">{entry.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {effortChoice !== null && (
          <>
            {modelChoice !== null && <DropdownMenuSeparator />}
            {effortChoice.type === "boolean" ? (
              <DropdownMenuCheckboxItem
                checked={effortChoice.currentValue === true}
                onCheckedChange={(checked) =>
                  onConfig?.(effortChoice.id, checked)
                }
              >
                {effortChoice.name}
              </DropdownMenuCheckboxItem>
            ) : (
              <>
                <DropdownMenuLabel>{t("acp.prompt.effort")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(effortChoice.currentValue)}
                  onValueChange={(value) => onConfig?.(effortChoice.id, value)}
                >
                  {effortChoice.options.map((choice) => (
                    <DropdownMenuRadioItem
                      key={choice.value}
                      value={choice.value}
                    >
                      {choice.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 其余配置项直接放在操作行上，每项一个独立的紧凑控件：select 是无边下拉，宽屏
 * 写「项名 · 值 ⌄」（项名先截断，值留着），窄屏只写值；boolean 是带边框的切换
 * 胶囊，打开时换底色。悬停给全名。
 */
export function ConfigControl({
  option,
  onConfig,
  disabled,
  compact,
}: {
  option: TimelineConfigOption;
  onConfig: (configId: string, value: string | boolean) => void;
  disabled: boolean;
  compact: boolean;
}) {
  if (option.type === "boolean") {
    return (
      <Toggle
        size="sm"
        variant="outline"
        data-slot="acp-config-toggle"
        title={option.name}
        pressed={option.currentValue === true}
        disabled={disabled}
        onPressedChange={(pressed) => onConfig(option.id, pressed)}
        className="max-w-36 min-w-0 shrink-0 rounded-full px-2.5 font-normal text-muted-foreground data-[state=on]:border-transparent data-[state=on]:text-foreground"
      >
        <span className="min-w-0 truncate">{option.name}</span>
      </Toggle>
    );
  }
  const value = configValueName(option);
  return (
    <Select
      value={String(option.currentValue)}
      disabled={disabled}
      onValueChange={(next) => onConfig(option.id, next)}
    >
      <SelectTrigger
        size="sm"
        aria-label={option.name}
        title={`${option.name} · ${value}`}
        data-slot="acp-config-select"
        className={cn(
          QUIET_TRIGGER,
          "gap-1 px-2",
          compact ? "max-w-32" : "max-w-64",
        )}
      >
        {!compact && (
          <span
            data-slot="acp-config-label"
            className="min-w-0 shrink truncate"
          >
            {option.name}
          </span>
        )}
        {!compact && (
          <span aria-hidden className="shrink-0">
            ·
          </span>
        )}
        <span
          data-slot="acp-config-value"
          className="max-w-24 min-w-0 shrink-0 truncate text-foreground"
        >
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {option.options.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
