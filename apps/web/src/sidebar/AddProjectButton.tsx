import { useState } from "react";
import { Plus } from "lucide-react";

import type { Source } from "../api/source";
import { useT } from "../app/preferences-store";
import { useOpenWorkspace } from "../app/workspace-actions";
import { NewWorkspaceDialog } from "../panels/NewWorkspaceDialog";
import { IconButton } from "@/ui/icon-button";

/**
 * 一台电脑那一组 / 那一段标题右边的 `+`：在**那台**电脑上添加项目（#903）。
 *
 * 对话框的请求都钉在 `source` 上，建好就打开它——打开别的电脑上的工作空间时
 * 当前源跟过去（`sources/follow-workspace.ts`），之后的「新建画布」也就建在那台。
 * 本机的系统目录选择器只在目标是本机时给（选出来的是本机路径）。
 */
export function AddProjectButton({
  source,
  busy = false,
}: {
  source: Source;
  busy?: boolean;
}) {
  const t = useT();
  const openWorkspace = useOpenWorkspace();
  const [dialog, setDialog] = useState(false);

  return (
    <>
      <IconButton
        label={t("sidebar.addProject")}
        className="shrink-0"
        disabled={busy}
        data-add-project={source.sourceId}
        onClick={() => setDialog(true)}
      >
        <Plus />
      </IconButton>
      <NewWorkspaceDialog
        open={dialog}
        source={source}
        onOpenChange={setDialog}
        onCreated={(workspace) => openWorkspace(workspace, source.sourceId)}
      />
    </>
  );
}
