import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  CalendarClock,
  File as FileIcon,
  FileCode,
  FolderOpen,
  FolderTree,
  Frame,
  GitCompare,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Shapes,
  StickyNote,
  Terminal,
  Type,
} from "lucide-react";

import { useT } from "@/app/preferences-store";
import { CommandGroup, CommandItem, CommandMeta } from "@/ui/command";
import type { FileHit } from "./use-file-hits";
import type { EntryIcon, SearchEntry, SearchHit } from "./index";

/** 条目图标键 → lucide 图标；与新建菜单里同一类对象用同一个图标。 */
export const ENTRY_ICONS: Record<EntryIcon, LucideIcon> = {
  workspace: FolderOpen,
  board: LayoutGrid,
  terminal: Terminal,
  agent: Bot,
  sticky: StickyNote,
  group: Frame,
  editor: FileCode,
  diff: GitCompare,
  files: FolderTree,
  browser: Globe,
  automation: CalendarClock,
  activity: Activity,
  text: Type,
  shape: Shapes,
  image: ImageIcon,
};

/** 一行：图标、标题、（命中正文时的）摘要、右对齐的次级标签。 */
export function SearchRow({
  icon: Icon,
  title,
  detail,
  label,
  value,
  onSelect,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  label?: string;
  value: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      <Icon />
      <span
        className={
          detail ? "max-w-[50%] shrink-0 truncate" : "min-w-0 truncate"
        }
      >
        {title}
      </span>
      {detail && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {detail}
        </span>
      )}
      {label && <CommandMeta>{label}</CommandMeta>}
    </CommandItem>
  );
}

/** 次级标签：画布条目给所在工作空间；节点与白板对象给画布，跨工作空间时带上工作空间。 */
export function entryLabel(
  entry: SearchEntry,
  currentWorkspaceId: string | null,
  location: (workspace: string, board: string) => string,
): string {
  if (entry.kind === "workspace") return "";
  if (entry.kind === "board") return entry.workspaceName;
  return entry.workspaceId === currentWorkspaceId
    ? entry.boardName
    : location(entry.workspaceName, entry.boardName);
}

/** 一组条目命中（工作空间 / 画布 / 节点 / 白板内容）。空组不画。 */
export function EntryGroup({
  heading,
  hits,
  currentWorkspaceId,
  onPick,
}: {
  heading: string;
  hits: readonly SearchHit[];
  currentWorkspaceId: string | null;
  onPick: (entry: SearchEntry) => void;
}) {
  const t = useT();
  if (hits.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {hits.map(({ entry, snippet }) => (
        <SearchRow
          key={entry.id}
          value={entry.id}
          icon={ENTRY_ICONS[entry.icon]}
          title={entry.title}
          detail={snippet}
          label={entryLabel(entry, currentWorkspaceId, (workspace, board) =>
            t("search.location", { workspace, board }),
          )}
          onSelect={() => onPick(entry)}
        />
      ))}
    </CommandGroup>
  );
}

/** 文件命中：行尾是所在目录（相对路径去掉文件名）。 */
export function FileGroup({
  heading,
  files,
  onPick,
}: {
  heading: string;
  files: readonly FileHit[];
  onPick: (file: FileHit) => void;
}) {
  if (files.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        return (
          <SearchRow
            key={file.path}
            value={`file:${file.path}`}
            icon={FileIcon}
            title={file.name}
            label={slash > 0 ? file.path.slice(0, slash) : ""}
            onSelect={() => onPick(file)}
          />
        );
      })}
    </CommandGroup>
  );
}

/** 一组命中里的最高分：⌘K 按它给分组排序。 */
export function topScore(hits: readonly SearchHit[]): number {
  return hits.reduce((best, hit) => Math.max(best, hit.score), 0);
}
