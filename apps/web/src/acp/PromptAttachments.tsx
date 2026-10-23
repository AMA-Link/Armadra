import * as React from "react";
import { File as FileIcon, FileText, Paperclip, X } from "lucide-react";
import {
  MAX_ACP_ATTACHMENTS,
  MAX_ACP_IMAGE_BYTES,
  MAX_AGENT_UPLOAD_BYTES,
  type AcpPromptCapabilities,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";

/**
 * 输入框里待发的附件（契约 §56）：粘贴、拖放或点回形针加进来，发出去之前可以
 * 移除。图片画缩略图，别的画一枚带名字的徽标。字节只在这台浏览器的内存里，发送
 * 时才上传到会话所在的 core。
 */

/** 图片块收的四种（与 `core/acp/attachments.ts` 同一张表）。 */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface PromptAttachment {
  readonly key: string;
  readonly file: File;
  /** 图片的 `blob:` 预览地址；别的文件没有。 */
  readonly preview?: string;
}

export function isPromptImage(file: File): boolean {
  return IMAGE_TYPES.has(file.type);
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

let sequence = 0;

/**
 * 附件的状态与加入时的判断。`capabilities` 为 `null`（会话还没开好、或 core 太旧）
 * 时什么都加不进来；Agent 没声明收图片时图片不加，`remote`（SSH 节点）且不收内嵌
 * 正文时别的文件不加——都当场说一句，不留到发送时才失败。
 */
export function usePromptAttachments(
  capabilities: AcpPromptCapabilities | null,
  remote: boolean,
) {
  const t = useT();
  const [items, setItems] = React.useState<readonly PromptAttachment[]>([]);
  const itemsRef = React.useRef(items);
  itemsRef.current = items;

  // 卸载时收回预览地址。
  React.useEffect(
    () => () => {
      for (const item of itemsRef.current)
        if (item.preview) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const add = React.useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (capabilities === null) {
        toast.error(t("acp.attach.unavailable"));
        return;
      }
      const next: PromptAttachment[] = [];
      let room = MAX_ACP_ATTACHMENTS - itemsRef.current.length;
      for (const file of files) {
        if (room <= 0) {
          toast.error(t("acp.attach.tooMany", { count: MAX_ACP_ATTACHMENTS }));
          break;
        }
        const image = isPromptImage(file);
        if (image && !capabilities.image) {
          toast.error(t("acp.attach.imageUnsupported"));
          continue;
        }
        if (!image && remote && !capabilities.embeddedContext) {
          toast.error(t("acp.attach.fileUnsupported"));
          continue;
        }
        const limit = image ? MAX_ACP_IMAGE_BYTES : MAX_AGENT_UPLOAD_BYTES;
        if (file.size > limit) {
          toast.error(
            t("acp.attach.tooLarge", {
              name: file.name,
              size: megabytes(limit),
            }),
          );
          continue;
        }
        sequence += 1;
        next.push({
          key: `a${sequence}`,
          file,
          ...(image ? { preview: URL.createObjectURL(file) } : {}),
        });
        room -= 1;
      }
      if (next.length > 0) setItems((current) => [...current, ...next]);
    },
    [capabilities, remote, t],
  );

  const remove = React.useCallback((key: string) => {
    setItems((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return current.filter((item) => item.key !== key);
    });
  }, []);

  /** 发出去了：清空，但预览地址交给消息里那一条，不在这里收回。 */
  const take = React.useCallback((): readonly PromptAttachment[] => {
    const taken = itemsRef.current;
    setItems([]);
    return taken;
  }, []);

  /** 没发出去：放回来。 */
  const restore = React.useCallback((taken: readonly PromptAttachment[]) => {
    setItems((current) => [...taken, ...current]);
  }, []);

  return { items, add, remove, take, restore, capabilities };
}

export type PromptAttachments = ReturnType<typeof usePromptAttachments>;

/** 输入框上方的一行附件。 */
export function AttachmentTray({
  items,
  onRemove,
  disabled,
}: {
  items: readonly PromptAttachment[];
  onRemove: (key: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ul
      data-slot="acp-attachments"
      aria-label={t("acp.attach")}
      className="flex flex-wrap items-center gap-1.5 px-1.5 pt-1.5"
    >
      {items.map((item) => {
        const name = item.file.name || t("acp.attach");
        const remove = (
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t("acp.attach.remove", { name })}
            onClick={() => onRemove(item.key)}
          >
            <X />
          </Button>
        );
        if (item.preview) {
          return (
            <li
              key={item.key}
              className="relative flex items-center gap-0.5 rounded-control border border-border p-0.5"
              title={name}
            >
              <img
                src={item.preview}
                alt={name}
                className="size-8 rounded-tight object-cover"
              />
              {remove}
            </li>
          );
        }
        const Icon = item.file.type.startsWith("text/") ? FileText : FileIcon;
        return (
          <li
            key={item.key}
            title={name}
            className="flex h-8 max-w-48 items-center gap-1 rounded-control border border-border-strong pl-2 text-meta [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
          >
            <Icon aria-hidden />
            <span className="min-w-0 truncate">{name}</span>
            {remove}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 拖文件进会话视图时盖上的一层：`--brand` 1.5px 虚线框 + 图标与一个词；只给视觉，
 * 事件仍由会话视图根上的 `onDragOver / onDrop` 处理（`pointer-events-none`）。
 * 不能收的时候（离线、没开好）`disabled` 换成 `--border-strong` 灰框。
 */
export function DropOverlay({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  return (
    <div
      data-slot="acp-drop-overlay"
      data-disabled={disabled || undefined}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center gap-1.5 rounded-card border-[1.5px] border-dashed bg-card/80 text-body",
        disabled
          ? "border-border-strong text-muted-foreground"
          : "border-brand text-brand-text",
      )}
    >
      <Paperclip className="size-4" />
      {t("acp.attach")}
    </div>
  );
}
