import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, type LucideIcon } from "lucide-react";
import { basename } from "../agent/sessions";
import { formatRelativeTime } from "../lib/format";
import {
  resumeLaunchCommand,
  useConversations,
  type Conversation,
} from "../meta/conversations";
import { COMMANDS, commandKeysLabel, formatKeys } from "../keybindings";
import { useCanvasStore } from "../store/canvas-store";
import { useCommandDispatch } from "../app/commands";
import { useEnabledAgents } from "../app/use-agents";
import { useT } from "../app/preferences-store";
import { sshMenuItems } from "../canvas/menus/add-menu";
import { requestCenterOnNode } from "../canvas/flow/flow-context";
import { nodeDropPosition } from "../canvas/placement";
import { useSshHosts } from "./settings/ssh-hosts";
import { useTerminalNodeCommands } from "./delivery-commands";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/ui/command";
import { Spinner } from "@/ui/spinner";
import { readRecent, rememberRecent } from "./palette-recent";
import { QUICK_PICK_COUNT, quickPickKeyDown } from "./quick-pick";

/** 一次最多列这么多个跳转目标，超过靠输入过滤。 */
const MAX_NODE_RESULTS = 50;

/** 运行后项尾的对勾停多久（设计系统 §11.2）。 */
export const RAN_MARK_MS = 800;

/**
 * 运行完面板不关的命令：只改视图、不移动焦点、常常要连着按几次（放大、缩小、
 * 撤销、重做、网格）。其余命令运行即关，焦点交给它们打开的东西。
 */
export const STAY_OPEN_COMMANDS: ReadonlySet<string> = new Set([
  "canvas.zoomIn",
  "canvas.zoomOut",
  "canvas.zoom100",
  "canvas.undo",
  "canvas.redo",
  "canvas.toggleGrid",
]);

/** 面板里一行可运行的项：新建菜单项或命令表里的命令。 */
interface Entry {
  /** `new:<菜单项 id>` / `cmd:<命令 id>`，也是「最近」里存的值。 */
  key: string;
  label: string;
  icon?: LucideIcon;
  /** 右侧显示的快捷键（已按平台和用户键位格式化）。 */
  keys: string;
  disabled: boolean;
  stay: boolean;
  run: () => void;
}

/**
 * 命令面板（⌘K，§3.6）：键盘中枢。开关没有动画；没输入时先列「最近」，前五项
 * 右侧是 ⌘1–⌘5（输入之后 ⌘1–⌘5 运行当前排在前五的行）；快捷键用 `Kbd` 显示；
 * 不关面板的命令运行后项尾画出对勾 800ms。其余是新建 / 跳转 / 命令三组。
 * 没有说明文字。
 */
export function CommandPalette() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.palette);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const document = useCanvasStore((state) => state.document);
  const selectNodes = useCanvasStore((state) => state.selectNodes);
  const addNode = useCanvasStore((state) => state.addNode);
  const agents = useEnabledAgents();
  const { run, addMenuItems, centerPosition } = useCommandDispatch();
  const hosts = useSshHosts();
  // SSH 终端项和添加菜单是同一份规格（§21），只是这里另外拼进「新建」组。
  const newItems = useMemo(
    () => [
      ...addMenuItems.filter((item) => item.group !== "canvas"),
      ...sshMenuItems(hosts, t),
    ],
    [addMenuItems, hosts, t],
  );
  // 选中的那个终端能做的几件事（投递队列、接管 / 交还）。
  const terminalCommands = useTerminalNodeCommands(t);
  const [query, setQuery] = useState("");
  // 历史对话索引（§17）：只在面板开着时查，输入去抖 150ms。
  const conversations = useConversations(query, open);

  const nodes = useMemo(
    () => (document?.nodes ?? []).slice(0, MAX_NODE_RESULTS),
    [document],
  );

  const close = () => setPanel("palette", false);

  // 最近使用：每次打开重新读一遍，别处记下的也算
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (open) setRecent(readRecent());
    else setQuery("");
  }, [open]);

  // 运行后项尾的对勾
  const [ranKey, setRanKey] = useState<string | null>(null);
  const ranTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(ranTimer.current), []);
  useEffect(() => {
    if (!open) setRanKey(null);
  }, [open]);

  const context = workspace
    ? { addNode, position: centerPosition(), workspace, agents }
    : null;
  const newEntries: Entry[] = context
    ? newItems.map((item) => ({
        key: `new:${item.id}`,
        label: item.label,
        icon: item.icon,
        keys: item.shortcut ? commandKeysLabel(item.shortcut) : "",
        disabled: Boolean(item.disabledReason?.(context)),
        stay: false,
        run: () => item.run({ ...context, position: centerPosition() }),
      }))
    : [];
  const commandEntries: Entry[] = COMMANDS.filter(
    (command) => command.id !== "app.commandPalette",
  ).map((command) => ({
    key: `cmd:${command.id}`,
    label: t(command.labelKey),
    keys: commandKeysLabel(command.id),
    disabled: false,
    stay: STAY_OPEN_COMMANDS.has(command.id),
    run: () => run(command.id),
  }));

  // 没输入时「最近」置顶，主列表里不再重复；输入后它退场，交给 cmdk 排序
  const byKey = new Map(
    [...newEntries, ...commandEntries].map((e) => [e.key, e]),
  );
  const recentEntries =
    query.trim() === ""
      ? recent
          .map((key) => byKey.get(key))
          .filter((entry): entry is Entry => entry !== undefined)
      : [];
  const recentKeys = new Set(recentEntries.map((entry) => entry.key));

  function activate(entry: Entry) {
    // 只落盘，不刷新这一次的列表：连按几次时行不该在手底下跳到「最近」去
    rememberRecent(entry.key);
    if (!entry.stay) {
      close();
      entry.run();
      return;
    }
    entry.run();
    setRanKey(entry.key);
    window.clearTimeout(ranTimer.current);
    ranTimer.current = window.setTimeout(() => setRanKey(null), RAN_MARK_MS);
  }

  /** 一行：图标、名字、右侧的快捷键（或 ⌘N 快选号），运行后换成对勾。 */
  function row(entry: Entry, group: string, quickPick?: number) {
    const Icon = entry.icon;
    const trailing =
      quickPick === undefined ? entry.keys : formatKeys(`Mod+${quickPick}`);
    return (
      <CommandItem
        key={`${group}:${entry.key}`}
        value={`${group} ${entry.label}`}
        disabled={entry.disabled}
        onSelect={() => activate(entry)}
      >
        {Icon && <Icon />}
        {entry.label}
        {ranKey === entry.key ? (
          <span data-slot="command-shortcut" className="ml-auto inline-flex">
            <Spinner state="done" aria-label={t("palette.ran")} />
          </span>
        ) : (
          trailing && <CommandShortcut>{trailing}</CommandShortcut>
        )}
      </CommandItem>
    );
  }

  /** 选中一条历史对话：在视口中心开一个以 `--resume` 启动的终端节点。 */
  function resume(conversation: Conversation) {
    const command = resumeLaunchCommand(
      conversation.provider,
      conversation.sessionId,
    );
    if (!command) return;
    close();
    addNode("terminal", {
      position: nodeDropPosition("terminal"),
      title: conversation.title,
      data: {
        kind: "terminal",
        cwd: conversation.cwd,
        agent: {
          id: conversation.provider,
          initialCommand: command,
          // 启动行在这里就定了，交给 `pending-launch`（无依赖 = 提示符一安静
          // 就敲）而不是让 TerminalSurface 自己拼——它拼不出 `--resume`。
          pendingLaunch: { command, after: [] },
        },
      },
    });
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => setPanel("palette", next)}
      className="z-[var(--z-dialog)]"
      title={t("cluster.palette")}
      description={t("palette.description")}
    >
      <CommandInput
        placeholder={t("palette.placeholder")}
        value={query}
        onValueChange={setQuery}
        onKeyDown={quickPickKeyDown}
      />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>

        {recentEntries.length > 0 && (
          <CommandGroup heading={t("palette.recent")}>
            {recentEntries
              .slice(0, QUICK_PICK_COUNT)
              .map((entry, index) =>
                row(entry, t("palette.recent"), index + 1),
              )}
          </CommandGroup>
        )}

        {newEntries.length > 0 && (
          <CommandGroup heading={t("palette.new")}>
            {newEntries
              .filter((entry) => !recentKeys.has(entry.key))
              .map((entry) => row(entry, t("palette.new")))}
          </CommandGroup>
        )}

        {nodes.length > 0 && (
          <CommandGroup heading={t("palette.goto")}>
            {nodes.map((node) => (
              <CommandItem
                key={node.id}
                value={`${t("palette.goto")} ${node.title}`}
                onSelect={() => {
                  close();
                  selectNodes([node.id]);
                  // 居中的算术在画布那边（§9.1）：这里只发事件，
                  // 免得壳自己复刻一份节点尺寸与缩放的规则。
                  requestCenterOnNode(node.id);
                }}
              >
                {node.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {workspace && (conversations.data?.length ?? 0) > 0 && (
          <CommandGroup heading={t("meta.conversations")}>
            {conversations.data!.map((conversation) => (
              <CommandItem
                key={`${conversation.provider}:${conversation.sessionId}`}
                value={`${t("meta.conversations")} ${conversation.title} ${basename(conversation.cwd)} ${conversation.provider}`}
                onSelect={() => resume(conversation)}
              >
                <Bot />
                <span className="min-w-0 flex-1 truncate">
                  {conversation.title}
                </span>
                {/* 目录名和时间是文字，不是快捷键：不放进 Kbd */}
                <span className="max-w-[30%] truncate text-caption text-muted-foreground">
                  {basename(conversation.cwd)}
                </span>
                <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                  {formatRelativeTime(conversation.updatedAt)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/*
          选中的那个终端节点能做的两件事（设计 `agent-delivery.md` §10）。
          只对**当前选中的终端节点**出现：这两条都是对一个具体终端说的话，
          没有选中任何终端时它们没有主语。
        */}
        {terminalCommands.length > 0 && (
          <CommandGroup heading={t("palette.command")}>
            {terminalCommands.map((command) => (
              <CommandItem
                key={command.id}
                value={`${t("palette.command")} ${command.label}`}
                onSelect={() => {
                  close();
                  command.run();
                }}
              >
                {command.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading={t("palette.command")}>
          {commandEntries
            .filter((entry) => !recentKeys.has(entry.key))
            .map((entry) => row(entry, t("palette.command")))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
