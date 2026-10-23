import * as React from "react";
import { ArrowUp, Ellipsis, Paperclip, Square } from "lucide-react";
import type {
  AcpAvailableCommand,
  AcpModeState,
  AcpModelState,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/ui/command";
import {
  DropdownMenu,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Progress, progressToneFor } from "@/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { Textarea } from "@/ui/textarea";
import { filesOf } from "@/terminal/file-paste";
import { acpApi } from "./api";
import {
  AttachmentTray,
  type PromptAttachment,
  type PromptAttachments,
  usePromptAttachments,
} from "./PromptAttachments";

/** 上下文用量到这个比例换琥珀色（≥ 95% 换红色，见 `progressToneFor`）。 */
export const USAGE_WARN_RATIO = 0.8;

/** 模式不超过这么多个、名字不超过这么多字，才画成分段控件。 */
export const SEGMENTED_MODES_MAX = 3;
export const SEGMENTED_NAME_MAX = 10;

/** 一次回填：`seq` 变了才填，同一句可以填第二次。 */
export interface PromptPrefill {
  readonly text: string;
  readonly seq: number;
}

/** `/` 开头、还没有空格时，按名字筛命令。 */
export function matchCommands(
  text: string,
  commands: readonly AcpAvailableCommand[],
): AcpAvailableCommand[] | null {
  if (!text.startsWith("/") || /\s/.test(text) || commands.length === 0)
    return null;
  const query = text.slice(1).toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(query));
  const rest = commands.filter(
    (c) =>
      !c.name.toLowerCase().startsWith(query) &&
      c.name.toLowerCase().includes(query),
  );
  return [...starts, ...rest];
}

/** 上下文用量：已用 / 总量；花费有就放进弹层。 */
export interface AcpUsageView {
  readonly used: number;
  readonly size: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
}

/** `/compact`：Agent 的可用命令里有它，用量弹层才出「压缩」。 */
export const COMPACT_COMMAND = "compact";

/**
 * 上下文窗口（设计系统 §5.1）：触发器是 20 格刻度条 + 等宽「18.3万 / 20万」，
 * 已用格 `--brand`、≥80% `--warn`、≥95% `--danger`；点开弹层是大数字（已用 /
 * 总量 / 百分比徽标）、剩余 tokens、费用（有才出）与「压缩」（只在命令里有 `compact`
 * 时出现，发送该命令）。数据里没有分类，所以不画图例。
 */
function Usage({
  usage,
  canCompact,
  busy,
  onCompact,
}: {
  usage: AcpUsageView;
  canCompact: boolean;
  /** 回合进行中或离线：「压缩」不可点。 */
  busy: boolean;
  onCompact: () => void;
}) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const [open, setOpen] = React.useState(false);
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const ratio = usage.size > 0 ? usage.used / usage.size : 0;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const tone = progressToneFor(percent);
  const values = {
    used: compact.format(usage.used),
    size: compact.format(usage.size),
  };
  let cost: string | null = null;
  if (usage.cost) {
    try {
      cost = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: usage.cost.currency,
      }).format(usage.cost.amount);
    } catch {
      // 币种认不出来：只给用量。
    }
  }
  const label = cost
    ? t("acp.usage.cost", { ...values, cost })
    : t("acp.usage", values);
  const warn = ratio >= USAGE_WARN_RATIO;
  const toneText =
    tone === "danger"
      ? "text-danger-text"
      : tone === "warn"
        ? "text-warn-text"
        : "text-muted-foreground";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          data-slot="acp-usage"
          data-warn={warn || undefined}
          data-tone={tone}
          aria-label={label}
          className={cn("shrink-0 gap-2 px-1.5 font-normal", toneText)}
        >
          <Progress
            variant="ticks"
            tone={tone}
            value={percent}
            aria-hidden
            className="w-16"
          />
          <span data-numeric className="font-mono text-caption">
            {t("acp.usage", values)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        data-slot="acp-usage-popover"
        className="w-64 gap-3"
      >
        <div className="flex items-baseline gap-1.5">
          <span data-numeric className="font-mono text-display">
            {values.used}
          </span>
          <span
            data-numeric
            className="font-mono text-meta text-muted-foreground"
          >
            / {values.size}
          </span>
          <Badge
            size="sm"
            variant={
              tone === "danger" ? "destructive" : warn ? "warn" : "brand"
            }
            className="ml-auto"
          >
            {percent}%
          </Badge>
        </div>
        <Progress variant="ticks" tone={tone} value={percent} aria-hidden />
        <div className="flex items-center justify-between gap-2 text-meta">
          <span
            data-slot="acp-usage-remaining"
            data-numeric
            className={cn("font-mono", warn ? "text-warn-text" : toneText)}
          >
            {t("acp.context.remaining", {
              value: compact.format(Math.max(0, usage.size - usage.used)),
            })}
          </span>
          {cost !== null && (
            <span data-numeric className="font-mono text-muted-foreground">
              {cost}
            </span>
          )}
        </div>
        {canCompact && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-slot="acp-usage-compact"
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            {t("acp.context.compact")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 会话视图底部的输入（ACP 设计 §6、§5.6）。
 *
 * Enter 发送、Shift+Enter 换行、输入法组字时的 Enter 不算；回合进行中发送钮
 * 换成停止（`session/cancel`），Esc 同样停止。
 *
 * 人在这里打字就不是 Agent 的回合：聚焦拿人类租约（`takeover`），失焦或
 * 提交交还（`release`），Agent 的 `send` 在这段时间排队——与终端模式同一条
 * 规矩，租约本身归 core。
 *
 * 模式与模型（契约 §26.2）只在有得选时出现：模式不超过三个且名字短时是分段控件，
 * 否则与模型一样是 Select；窄屏（≤ 767，含手机焦点页）两个收进一个「⋯」菜单，
 * 不挤占输入框。所有控件取 32 这一档，同一基线。
 */
export function PromptBox({
  sessionId,
  disabled,
  streaming,
  modes,
  models = null,
  onSubmit,
  onCancel,
  onMode,
  onModel,
  inputRef,
  compact: forceCompact,
  commands = [],
  usage = null,
  prefill = null,
  attachments: controlled,
}: {
  sessionId: string | null;
  disabled: boolean;
  streaming: boolean;
  modes: AcpModeState | null;
  models?: AcpModelState | null;
  /** 返回 `false` 时保留输入框里的字与附件。 */
  onSubmit: (
    text: string,
    attachments?: readonly PromptAttachment[],
  ) => Promise<boolean>;
  onCancel: () => void;
  onMode: (modeId: string) => void;
  onModel?: (modelId: string) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  /** 展示页用：不看视口，直接画窄屏那一版。 */
  compact?: boolean;
  /** `available_commands_update`：输入 `/` 时列出来。 */
  commands?: readonly AcpAvailableCommand[];
  usage?: AcpUsageView | null;
  /** 「编辑后重发」：把这句填进来，光标在末尾，不发。 */
  prefill?: PromptPrefill | null;
  /**
   * 契约 §56：待发的附件（`usePromptAttachments`）。会话视图持有它，好让拖到
   * 视图任何地方的文件都进这里；不给时没有回形针、粘不进附件。
   */
  attachments?: PromptAttachments;
}) {
  const t = useT();
  const narrow = useCompactLayout();
  const compact = forceCompact ?? narrow;
  const [text, setText] = React.useState("");
  const fallback = usePromptAttachments(null, false);
  const attachments = controlled ?? fallback;
  const attachable = controlled?.capabilities != null;
  const pickerRef = React.useRef<HTMLInputElement | null>(null);
  const holding = React.useRef<string | null>(null);
  const localRef = React.useRef<HTMLTextAreaElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef)
        (inputRef as React.RefObject<HTMLTextAreaElement | null>).current =
          node;
    },
    [inputRef],
  );

  React.useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    const input = localRef.current;
    if (!input) return;
    input.focus();
    // 填进去之后再放光标：这一帧 value 还是旧的。
    requestAnimationFrame(() => {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }, [prefill]);

  // 斜杠命令：`/` 开头时列出来，上下键选、Enter / Tab 插入、Esc 收起。
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState(0);
  const matches = dismissed === text ? null : matchCommands(text, commands);
  const listOpen = matches !== null && !disabled;
  React.useEffect(() => setPicked(0), [text]);
  const insert = (command: AcpAvailableCommand) => {
    setText(`/${command.name} `);
    setDismissed(null);
    localRef.current?.focus();
  };

  const take = React.useCallback(() => {
    if (!sessionId || holding.current === sessionId) return;
    holding.current = sessionId;
    void acpApi.drive(sessionId, "takeover").catch(() => undefined);
  }, [sessionId]);

  const release = React.useCallback(() => {
    const held = holding.current;
    if (!held) return;
    holding.current = null;
    void acpApi.drive(held, "release").catch(() => undefined);
  }, []);

  // 卸载或换了会话时把租约交回去，不留一个没人坐的驾驶位。
  React.useEffect(() => release, [sessionId, release]);

  const submit = async () => {
    const value = text.trim();
    if ((!value && attachments.items.length === 0) || disabled || streaming)
      return;
    const taken = attachments.take();
    setText("");
    release();
    // 没有附件时只交字：与没有附件那一版的调用形状一样。
    const sent = await (taken.length > 0
      ? onSubmit(value, taken)
      : onSubmit(value));
    if (!sent) {
      setText(value);
      attachments.restore(taken);
    }
  };
  const canSend = Boolean(text.trim()) || attachments.items.length > 0;

  const modeChoice = modes && modes.availableModes.length > 1 ? modes : null;
  // 模式少而名字短才画分段控件，否则窄节点里挤不下：回落到 Select。
  const segmentedModes =
    modeChoice !== null &&
    modeChoice.availableModes.length <= SEGMENTED_MODES_MAX &&
    modeChoice.availableModes.every(
      (mode) => mode.name.length <= SEGMENTED_NAME_MAX,
    );
  // 只有一个模型也画：让人看得见在用哪个（契约 §26.2 只在目录非空时给）。
  const modelChoice =
    models && onModel && models.availableModels.length > 0 ? models : null;

  return (
    <div className="relative border-t border-border">
      {listOpen && (
        <Command
          shouldFilter={false}
          value={matches[picked]?.name ?? ""}
          data-slot="acp-commands"
          aria-label={t("acp.commands.label")}
          className="absolute right-1.5 bottom-full left-1.5 z-10 mb-1 h-auto rounded-card! border border-border shadow-overlay"
        >
          <CommandList className="max-h-56">
            <CommandEmpty className="py-3">
              {t("acp.commands.empty")}
            </CommandEmpty>
            {matches.map((command) => (
              <CommandItem
                key={command.name}
                value={command.name}
                className="h-auto min-h-8 items-baseline py-1"
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => insert(command)}
              >
                <span className="shrink-0 font-mono text-body">
                  /{command.name}
                </span>
                <span className="min-w-0 truncate text-caption text-muted-foreground">
                  {command.description}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
      <AttachmentTray
        items={attachments.items}
        onRemove={attachments.remove}
        disabled={disabled}
      />
      <div className="flex items-end gap-1.5 p-1.5">
        {attachable && (
          <>
            <input
              ref={pickerRef}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={(event) => {
                attachments.add(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("acp.attach")}
              disabled={disabled}
              onClick={() => pickerRef.current?.click()}
            >
              <Paperclip />
            </Button>
          </>
        )}
        <Textarea
          ref={setRefs}
          aria-label={t("acp.prompt.label")}
          rows={1}
          value={text}
          disabled={disabled}
          className="max-h-[calc(6lh+1rem)] min-h-8 flex-1 resize-none overflow-y-auto py-[5px]"
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = filesOf(event.clipboardData);
            if (files.length === 0 || !controlled) return;
            // 截图或复制的文件：成附件，不粘出一个文件名。
            event.preventDefault();
            attachments.add(files);
          }}
          onFocus={take}
          onBlur={release}
          onKeyDown={(event) => {
            if (listOpen && !event.nativeEvent.isComposing) {
              const count = matches.length;
              if (event.key === "ArrowDown" && count > 0) {
                event.preventDefault();
                setPicked((index) => (index + 1) % count);
                return;
              }
              if (event.key === "ArrowUp" && count > 0) {
                event.preventDefault();
                setPicked((index) => (index - 1 + count) % count);
                return;
              }
              if (
                (event.key === "Enter" || event.key === "Tab") &&
                !event.shiftKey &&
                matches[picked]
              ) {
                event.preventDefault();
                insert(matches[picked]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(text);
                return;
              }
            }
            if (event.key === "Escape" && streaming) {
              event.preventDefault();
              onCancel();
              return;
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        {compact ? (
          (modeChoice || modelChoice) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("acp.prompt.more")}
                  disabled={disabled}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-h-[60dvh] min-w-44 overflow-y-auto"
              >
                {modeChoice && (
                  <>
                    <DropdownMenuLabel>
                      {t("acp.prompt.mode")}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={modeChoice.currentModeId}
                      onValueChange={onMode}
                    >
                      {modeChoice.availableModes.map((mode) => (
                        <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                          {mode.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                )}
                {modeChoice && modelChoice && <DropdownMenuSeparator />}
                {modelChoice && (
                  <>
                    <DropdownMenuLabel>
                      {t("acp.prompt.model")}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={modelChoice.currentModelId}
                      onValueChange={(id) => onModel?.(id)}
                    >
                      {modelChoice.availableModels.map((model) => (
                        <DropdownMenuRadioItem
                          key={model.modelId}
                          value={model.modelId}
                        >
                          {model.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
          <>
            {modelChoice && (
              <Select
                value={modelChoice.currentModelId}
                disabled={disabled}
                onValueChange={(id) => onModel?.(id)}
              >
                <SelectTrigger
                  aria-label={t("acp.prompt.model")}
                  className="max-w-36"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelChoice.availableModels.map((model) => (
                    <SelectItem key={model.modelId} value={model.modelId}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {modeChoice &&
              (segmentedModes ? (
                <Tabs value={modeChoice.currentModeId} onValueChange={onMode}>
                  <TabsList
                    variant="segmented"
                    size="sm"
                    aria-label={t("acp.prompt.mode")}
                    className="h-8"
                  >
                    {modeChoice.availableModes.map((mode) => (
                      <TabsTrigger
                        key={mode.id}
                        value={mode.id}
                        disabled={disabled}
                      >
                        {mode.name}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              ) : (
                <Select
                  value={modeChoice.currentModeId}
                  disabled={disabled}
                  onValueChange={onMode}
                >
                  <SelectTrigger
                    aria-label={t("acp.prompt.mode")}
                    className="max-w-32"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modeChoice.availableModes.map((mode) => (
                      <SelectItem key={mode.id} value={mode.id}>
                        {mode.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ))}
          </>
        )}
        {usage && usage.size > 0 && (
          <Usage
            usage={usage}
            canCompact={commands.some(
              (command) => command.name === COMPACT_COMMAND,
            )}
            busy={disabled || streaming}
            onCompact={() => void onSubmit(`/${COMPACT_COMMAND}`)}
          />
        )}
        {streaming ? (
          <Button
            size={compact ? "icon" : "default"}
            variant="outline"
            aria-label={t("acp.prompt.stop")}
            disabled={disabled}
            {...(compact ? {} : { shortcut: "Esc" })}
            onClick={onCancel}
          >
            {compact ? <Square /> : t("acp.prompt.stop")}
          </Button>
        ) : (
          <Button
            size={compact ? "icon" : "default"}
            aria-label={t("acp.prompt.send")}
            disabled={disabled || !canSend}
            {...(compact ? {} : { shortcut: "↵" })}
            onClick={() => void submit()}
          >
            {compact ? <ArrowUp /> : t("acp.prompt.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
