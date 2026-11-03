/**
 * 侧栏顶行的搜索面板（§27）。
 *
 * 它搜的是**内容**，不是命令：所有工作空间、所有画布，以及画布里的节点（标题、
 * 便签正文、路径、网址）与白板上的文字，外加当前工作空间的文件和 Runtime 那份
 * 历史对话索引。⌘K 的命令面板在这些之上再加设置、新建与命令。
 *
 * 匹配（含拼音首字母与模糊）全在 `search/` 里算，所以 cmdk 的内置过滤要关掉
 * （`shouldFilter={false}`）：历史对话是 Runtime 按它自己的索引给的，标题里未必
 * 逐字含有查询词，再过一遍模糊打分只会把对的条目筛掉。
 *
 * 落点：工作空间 → 切过去；画布 → 需要时先切工作空间再选画布；节点与白板对象 →
 * 再居中并选中；文件 → 编辑器节点；历史对话 → 以 `--resume` 起一个新终端节点
 * （与命令面板同一条路径）。
 */
import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";

import { basename } from "../agent/sessions";
import { useT } from "../app/preferences-store";
import { useOpenWorkspace } from "../app/workspace-actions";
import { nodeDropPosition } from "../canvas/placement";
import { formatRelativeTime } from "../lib/format";
import {
  resumeLaunchCommand,
  useConversations,
  type Conversation,
} from "../meta/conversations";
import { useCanvasStore } from "../store/canvas-store";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandMeta,
} from "@/ui/command";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { openFileInEditor } from "@/files/open-editor";
import { revealCreatedNode } from "@/canvas/created-node";
import { searchEntries } from "@/search";
import { navigateTo } from "@/search/navigate";
import { EntryGroup, FileGroup } from "@/search/SearchGroups";
import { useFileHits } from "@/search/use-file-hits";
import { useSearchEntries } from "@/search/use-search-entries";

export interface SidebarSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SidebarSearch({ open, onOpenChange }: SidebarSearchProps) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const boardId = useCanvasStore((state) => state.boardId);
  const addNode = useCanvasStore((state) => state.addNode);
  const openWorkspace = useOpenWorkspace();
  const [query, setQuery] = useState("");
  // 关掉就清空：下次打开从空白开始，不带着上一次的查询词。
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const conversations = useConversations(query, open);
  const { entries, workspaces } = useSearchEntries(open, query);
  const files = useFileHits(open, query);

  const groups = useMemo(
    () =>
      searchEntries(entries, query, {
        workspaceId: workspace?.id ?? null,
        boardId,
      }),
    [boardId, entries, query, workspace?.id],
  );

  const close = () => onOpenChange(false);

  const pick = (entry: Parameters<typeof navigateTo>[0]) => {
    close();
    navigateTo(entry, { workspaces, openWorkspace });
  };

  /** 选中一条历史对话：在视口中心开一个以 `--resume` 启动的终端节点。 */
  const resume = (conversation: Conversation) => {
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
          pendingLaunch: { command, after: [] },
        },
      },
    });
    if (id) revealCreatedNode(id);
  };

  const currentWorkspaceId = workspace?.id ?? null;
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="top-1/4 z-(--z-dialog) max-w-[600px]! translate-y-0 overflow-hidden rounded-dialog! p-0 sm:max-w-[600px]"
      >
        <ResponsiveDialogHeader className="sr-only">
          <ResponsiveDialogTitle>{t("search.title")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <Command className="p-0" shouldFilter={false}>
          <CommandInput
            placeholder={t("search.placeholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{t("search.empty")}</CommandEmpty>

            <EntryGroup
              heading={t("search.workspaces")}
              hits={groups.workspaces}
              currentWorkspaceId={currentWorkspaceId}
              onPick={pick}
            />
            <EntryGroup
              heading={t("search.boards")}
              hits={groups.boards}
              currentWorkspaceId={currentWorkspaceId}
              onPick={pick}
            />
            <EntryGroup
              heading={t("search.nodes")}
              hits={groups.nodes}
              currentWorkspaceId={currentWorkspaceId}
              onPick={pick}
            />
            <EntryGroup
              heading={t("search.items")}
              hits={groups.items}
              currentWorkspaceId={currentWorkspaceId}
              onPick={pick}
            />
            <FileGroup
              heading={t("search.files")}
              files={files}
              onPick={(file) => {
                close();
                openFileInEditor(file.path);
              }}
            />

            {workspace && (conversations.data?.length ?? 0) > 0 && (
              <CommandGroup heading={t("meta.conversations")}>
                {conversations.data!.map((conversation) => (
                  <CommandItem
                    key={`${conversation.provider}:${conversation.sessionId}`}
                    value={`chat:${conversation.provider}:${conversation.sessionId}`}
                    onSelect={() => resume(conversation)}
                  >
                    <Bot />
                    <span className="min-w-0 flex-1 truncate">
                      {conversation.title}
                    </span>
                    <CommandMeta className="ml-0">
                      {basename(conversation.cwd)}
                    </CommandMeta>
                    <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
                      {formatRelativeTime(conversation.updatedAt)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
