import { FileText, Pencil } from "lucide-react";
import type { TimelineUserItem } from "@armadra/shared";

import { Action, ActionBar, CopyAction } from "@/acp/MessageActions";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/cn";
import { Card } from "@/ui/card";
import { ENTRY_INSET } from "../entry";
import { ImagePart } from "../parts/ImagePart";
import { memoRow } from "../row-memo";

export interface UserRowProps {
  item: TimelineUserItem;
  /** 编辑后重发：把这句填回输入框；不给就没有这个动作。须是稳定引用。 */
  onEdit?: ((text: string) => void) | undefined;
}

/** 回合的开头：左对齐、占满宽度的提问块（`--surface-raised`），纯文本加附件缩略图。 */
function UserRowImpl({ item, onEdit }: UserRowProps) {
  const t = useT();
  const attachments = item.attachments ?? [];
  return (
    <div
      data-slot="timeline-user"
      className="group/act relative flex min-w-0 flex-col"
    >
      <Card
        data-role="user"
        className={cn(
          ENTRY_INSET,
          "gap-1.5 rounded-control bg-raised py-1.5 text-body text-strong shadow-none [overflow-wrap:anywhere] whitespace-pre-wrap",
        )}
      >
        {item.text !== "" && <span>{item.text}</span>}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {attachments.map((attachment, index) =>
              attachment.kind === "image" ? (
                <ImagePart
                  key={index}
                  compact
                  blobId={attachment.blobId}
                  mimeType={attachment.mimeType ?? "image/*"}
                  name={attachment.name}
                />
              ) : (
                <Badge
                  key={index}
                  variant="outline"
                  size="sm"
                  title={attachment.uri}
                >
                  <FileText />
                  {attachment.name ?? attachment.uri}
                </Badge>
              ),
            )}
          </div>
        )}
      </Card>
      {item.text !== "" && (
        <ActionBar className="absolute -top-2 right-1 rounded-control bg-raised">
          {onEdit !== undefined && (
            <Action
              label={t("acp.message.editResend")}
              onClick={() => onEdit(item.text)}
            >
              <Pencil />
            </Action>
          )}
          <CopyAction text={item.text} />
        </ActionBar>
      )}
    </div>
  );
}

export const UserRow = memoRow(UserRowImpl);
