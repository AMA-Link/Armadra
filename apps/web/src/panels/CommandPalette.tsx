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
import { useT, usePreferencesStore } from "../app/preferences-store";
import { sshMenuItems } from "../canvas/menus/add-menu";
import { nodeDropPosition } from "../canvas/placement";
import { useSshHosts } from "./settings/ssh-hosts";
import { useOpenWorkspace } from "../app/workspace-actions";
import { openFileInEditor } from "@/files/open-editor";
import { parseQuery, scoreText } from "@/search/match";
import { searchEntries } from "@/search";
import { navigateTo } from "@/search/navigate";
import {
  EntryGroup,
  FileGroup,
  SearchRow,
  topScore,
} from "@/search/SearchGroups";
import { useFileHits } from "@/search/use-file-hits";
import { useSearchEntries } from "@/search/use-search-entries";
import {
  searchSettingsEntries,
  useSettingsEntries,
} from "@/search/settings-entries";
import { Settings as SettingsIcon } from "lucide-react";
import { useTerminalNodeCommands } from "./delivery-commands";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandMeta,
  CommandShortcut,
} from "@/ui/command";
import { Spinner } from "@/ui/spinner";
import { readRecent, rememberRecent } from "./palette-recent";
import { QUICK_PICK_COUNT, quickPickKeyDown } from "./quick-pick";
import { revealCreatedNode } from "@/canvas/created-node";

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
  const boardId = useCanvasStore((state) => state.boardId);
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

  const openWorkspace = useOpenWorkspace();
  const rememberSection = usePreferencesStore(
    (state) => state.setLastSettingsSection,
  );
  // 内容索引（工作空间、画布、节点、白板对象）、文件、设置项：匹配全在 `search/`，
  // 所以 cmdk 的内置过滤关掉，命令与新建项也走同一套匹配（拼音首字母、模糊）。
  const { entries, workspaces } = useSearchEntries(open, query);
  const files = useFileHits(open, query);
  const settingsEntries = useSettingsEntries(open);
  const terms = useMemo(() => parseQuery(query), [query]);
  const typing = terms.length > 0;
  const groups = useMemo(() => {
    const found = searchEntries(entries, query, {
      workspaceId: workspace?.id ?? null,
      boardId,
    });
    // 空查询时这是命令面板：只带出画布与当前画布的节点，不列工作空间。
    return typing ? found : { ...found, workspaces: [] };
  }, [boardId, entries, query, typing, workspace?.id]);
  const settingsHits = useMemo(
    () => searchSettingsEntries(settingsEntries, query),
    [query, settingsEntries],
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

  /** 新建项与命令按查询词过滤、按得分排序；没输入时原样。 */
  function rank<T>(items: readonly T[], labelOf: (item: T) => string): T[] {
    if (!typing) return [...items];
    return items
      .map((item) => ({ item, score: scoreText(terms, labelOf(item)) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((hit) => hit.item);
  }
  const best = (items: readonly { label: string }[]) =>
    items.reduce((top, item) => Math.max(top, scoreText(terms, item.label)), 0);

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
    const id = addNode("terminal", {
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
    if (id) revealCreatedNode(id);
  }

  const mainEntries = (list: readonly Entry[]) =>
    rank(
      list.filter((entry) => !recentKeys.has(entry.key)),
      (entry) => entry.label,
    );
  const newRows = mainEntries(newEntries);
  const commandRows = mainEntries(commandEntries);
  const terminalRows = rank(terminalCommands, (command) => command.label);
  const currentWorkspaceId = workspace?.id ?? null;

  const pick = (entry: Parameters<typeof navigateTo>[0]) => {
    close();
    navigateTo(entry, { workspaces, openWorkspace });
  };

  const entryGroup = (
    key: "workspaces" | "boards" | "nodes" | "items",
    heading: string,
  ) => ({
    key,
    rank: topScore(groups[key]),
    node: (
      <EntryGroup
        key={key}
        heading={heading}
        hits={groups[key]}
        currentWorkspaceId={currentWorkspaceId}
        onPick={pick}
      />
    ),
  });

  /**
   * 分组顺序：没输入时是固定的（最近、新建、画布、节点、对话、命令）；输入之后
   * 按各组最高分排，同分保持这个固定顺序——输入「画布」时画布在前，输入「放大」
   * 时命令在前。
   */
  const sections = [
    {
      key: "recent",
      rank: 0,
      node:
        recentEntries.length > 0 ? (
          <CommandGroup key="recent" heading={t("palette.recent")}>
            {recentEntries
              .slice(0, QUICK_PICK_COUNT)
              .map((entry, index) =>
                row(entry, t("palette.recent"), index + 1),
              )}
          </CommandGroup>
        ) : null,
    },
    {
      key: "new",
      rank: best(newRows),
      node:
        newRows.length > 0 ? (
          <CommandGroup key="new" heading={t("palette.new")}>
            {newRows.map((entry) => row(entry, t("palette.new")))}
          </CommandGroup>
        ) : null,
    },
    entryGroup("workspaces", t("search.workspaces")),
    entryGroup("boards", t("search.boards")),
    entryGroup("nodes", t("search.nodes")),
    entryGroup("items", t("search.items")),
    {
      key: "files",
      rank: 50,
      node: (
        <FileGroup
          key="files"
          heading={t("search.files")}
          files={files}
          onPick={(file) => {
            close();
            openFileInEditor(file.path);
          }}
        />
      ),
    },
    {
      key: "settings",
      rank: 45,
      node:
        settingsHits.length > 0 ? (
          <CommandGroup key="settings" heading={t("search.settings")}>
            {settingsHits.map((hit) => (
              <SearchRow
                key={`${hit.sectionId}:${hit.rowKey ?? ""}`}
                value={`setting:${hit.sectionId}:${hit.rowKey ?? ""}`}
                icon={SettingsIcon}
                title={hit.title}
                label={hit.page}
                onSelect={() => {
                  close();
                  rememberSection(hit.sectionId);
                  setPanel("settings", true);
                }}
              />
            ))}
          </CommandGroup>
        ) : null,
    },
    {
      key: "conversations",
      rank: 40,
      node:
        workspace && (conversations.data?.length ?? 0) > 0 ? (
          <CommandGroup key="conversations" heading={t("meta.conversations")}>
            {conversations.data!.map((conversation) => (
              <CommandItem
                key={`${conversation.provider}:${conversation.sessionId}`}
                value={`${t("meta.conversations")} ${conversation.provider}:${conversation.sessionId}`}
                onSelect={() => resume(conversation)}
              >
                <Bot />
                <span className="min-w-0 flex-1 truncate">
                  {conversation.title}
                </span>
                {/* 目录名和时间是文字，不是快捷键：不放进 Kbd */}
                <CommandMeta className="ml-0 max-w-[30%]">
                  {basename(conversation.cwd)}
                </CommandMeta>
                <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                  {formatRelativeTime(conversation.updatedAt)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null,
    },
    {
      /*
        选中的那个终端节点能做的两件事（设计 `agent-delivery.md` §10）。
        只对**当前选中的终端节点**出现：这两条都是对一个具体终端说的话，
        没有选中任何终端时它们没有主语。
      */
      key: "terminal",
      rank: best(terminalRows),
      node:
        terminalRows.length > 0 ? (
          <CommandGroup key="terminal" heading={t("palette.command")}>
            {terminalRows.map((command) => (
              <CommandItem
                key={command.id}
                value={`${t("palette.command")} ${command.id}`}
                onSelect={() => {
                  close();
                  command.run();
                }}
              >
                {command.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null,
    },
    {
      key: "commands",
      rank: best(commandRows),
      node:
        commandRows.length > 0 ? (
          <CommandGroup key="commands" heading={t("palette.command")}>
            {commandRows.map((entry) => row(entry, t("palette.command")))}
          </CommandGroup>
        ) : null,
    },
  ];
  const ordered = typing
    ? [...sections].sort((a, b) => b.rank - a.rank)
    : sections;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => setPanel("palette", next)}
      className="z-[var(--z-dialog)]"
      title={t("cluster.palette")}
      description={t("palette.description")}
      shouldFilter={false}
    >
      <CommandInput
        placeholder={t("palette.placeholder")}
        value={query}
        onValueChange={setQuery}
        onKeyDown={quickPickKeyDown}
      />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        {ordered.map((section) => section.node)}
      </CommandList>
    </CommandDialog>
  );
}
