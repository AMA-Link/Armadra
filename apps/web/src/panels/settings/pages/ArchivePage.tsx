import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import {
  ARCHIVED_WORKSPACES_KEY,
  useRemoveWorkspace,
  useRestoreWorkspace,
} from "../../../app/remove-workspace";
import { displayName } from "../../../sidebar/display-name";
import { formatElapsedTime } from "../../../lib/format";
import { sk } from "../../../sources/scope";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsLoadable } from "../SettingsLoadable";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";

/**
 * 设置 → 归档（契约 §89）：已归档的工作空间，最近归档的在前。每行「恢复」回到
 * 侧栏，「删除」一步删掉，都不确认。
 */
export function ArchivePage() {
  const t = useT();
  const archived = useQuery({
    queryKey: sk(ARCHIVED_WORKSPACES_KEY),
    queryFn: runtimeApi.listArchivedWorkspaces,
    retry: false,
  });
  const restore = useRestoreWorkspace();
  const remove = useRemoveWorkspace();
  const rows = archived.data ?? [];

  return (
    <>
      <SettingsPageHeader />
      <SettingsGroup>
        <SettingsLoadable loading={archived.isLoading} control="input">
          {rows.length === 0 ? (
            <SettingsRow label={t("settings.archive.empty")} />
          ) : (
            rows.map((workspace) => (
              <SettingsRow
                key={workspace.id}
                label={displayName(workspace.name, t)}
                footnote={formatElapsedTime(workspace.archivedAt)}
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restore.isPending || remove.isPending}
                  onClick={() => restore.mutate({ id: workspace.id })}
                >
                  {t("settings.archive.restore")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={restore.isPending || remove.isPending}
                  onClick={() => remove.mutate(workspace.id)}
                >
                  {t("settings.archive.delete")}
                </Button>
              </SettingsRow>
            ))
          )}
        </SettingsLoadable>
      </SettingsGroup>
    </>
  );
}
