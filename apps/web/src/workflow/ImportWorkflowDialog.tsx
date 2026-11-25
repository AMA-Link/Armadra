import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Loadable } from "@/loading/Loadable";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { Skeleton } from "@/ui/skeleton";
import { toast } from "@/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { type WorkflowFileEntry, workflowErrorKey, workflowsApi } from "./api";
import { workflowKeys } from "./store";

export interface ImportWorkflowDialogProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
}

/**
 * 导入工作流文件（契约 §121）：列出当前工作空间 `.ama/workflows` 里的文件，
 * 无效的行禁用并在提示里放问题，已导入的按钮是「更新」。
 */
export function ImportWorkflowDialog({
  open,
  workspaceId,
  onClose,
}: ImportWorkflowDialogProps) {
  const t = useT();
  const client = useQueryClient();
  const files = useQuery({
    queryKey: [...workflowKeys.all, "files", workspaceId ?? ""],
    queryFn: () => workflowsApi.files(workspaceId!),
    enabled: open && workspaceId !== null,
    retry: false,
  });
  const importing = useMutation({
    mutationFn: (id: string) => workflowsApi.importFile(workspaceId!, id),
    onSuccess: (answer) => {
      toast.success(t(`workflow.import.${answer.change}`));
      void client.invalidateQueries({ queryKey: workflowKeys.all });
    },
    onError: (error) => toast.error(t(workflowErrorKey(error))),
  });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent
        aria-describedby={undefined}
        className="sm:max-w-[480px]"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("workflow.import.title")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {files.error ? (
          <Alert variant="destructive">
            <AlertTitle className="font-normal break-words">
              {t(workflowErrorKey(files.error))}
            </AlertTitle>
          </Alert>
        ) : (
          <Loadable
            loading={files.isLoading}
            skeleton={
              <div
                role="status"
                aria-label={t("state.loading")}
                className="space-y-2"
              >
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            }
          >
            {(files.data ?? []).length === 0 ? (
              <Empty data-slot="workflow-import-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle className="text-body font-normal text-muted-foreground">
                    {t("workflow.import.empty")}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup data-slot="workflow-import-list" className="gap-2">
                {(files.data ?? []).map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    pending={
                      importing.isPending && importing.variables === file.id
                    }
                    onImport={() => importing.mutate(file.id)}
                  />
                ))}
              </ItemGroup>
            )}
          </Loadable>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function FileRow({
  file,
  pending,
  onImport,
}: {
  file: WorkflowFileEntry;
  pending: boolean;
  onImport: () => void;
}) {
  const t = useT();
  const button = (
    <Button
      size="sm"
      variant="outline"
      disabled={file.valid && pending}
      // 无效的行不用 `disabled`：它收不到焦点与悬停，提示就出不来。
      aria-disabled={!file.valid || undefined}
      className={file.valid ? undefined : "opacity-50"}
      data-slot="workflow-import-file"
      onClick={file.valid ? onImport : undefined}
    >
      {file.templateId ? t("workflow.import.update") : t("workflow.import")}
    </Button>
  );
  return (
    <Item
      variant="outline"
      size="sm"
      data-slot="workflow-import-row"
      data-file-id={file.id}
      data-valid={file.valid}
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">
          {file.title ?? file.id}
        </ItemTitle>
        <p className="truncate font-mono text-meta text-muted-foreground">
          {file.path}
        </p>
      </ItemContent>
      <ItemActions>
        {file.valid ? (
          button
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent className="max-w-xs break-words">
              {file.error}
            </TooltipContent>
          </Tooltip>
        )}
      </ItemActions>
    </Item>
  );
}
