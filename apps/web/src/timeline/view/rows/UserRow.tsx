import { FileText } from "lucide-react";
import type { TimelineUserItem } from "@armadra/shared";

import { ActionBar, CopyAction } from "@/acp/MessageActions";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { ImagePart } from "../parts/ImagePart";
import { memoRow } from "../row-memo";

export interface UserRowProps {
  item: TimelineUserItem;
}

/** 右侧气泡：纯文本加附件缩略图。 */
function UserRowImpl({ item }: UserRowProps) {
  const attachments = item.attachments ?? [];
  return (
    <div
      data-slot="timeline-user"
      className="group/act relative flex max-w-[85%] flex-col items-end gap-0.5 self-end"
    >
      <Card
        data-role="user"
        className="gap-1.5 rounded-[var(--r-card)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] [overflow-wrap:anywhere] whitespace-pre-wrap"
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
                <Badge key={index} variant="outline" title={attachment.uri}>
                  <FileText />
                  {attachment.name ?? attachment.uri}
                </Badge>
              ),
            )}
          </div>
        )}
      </Card>
      {item.text !== "" && (
        <ActionBar className="absolute top-0 right-full mr-1">
          <CopyAction text={item.text} />
        </ActionBar>
      )}
    </div>
  );
}

export const UserRow = memoRow(UserRowImpl);
