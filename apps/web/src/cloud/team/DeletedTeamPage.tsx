import { Trash2 } from "lucide-react";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/state";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { navigate, spacePath } from "../router";
import { PageState } from "../ui/PageState";
import { useDeletedTeams, useRestoreTeam } from "./data";

/**
 * 处于恢复期的团队（云端控制台 §3.3.1 状态）：`me.spaces` 不再列它，所有者在这里看到清除日期并恢复。
 * 不是它的所有者（或根本没有这个团队）就是「找不到」。
 */
export function DeletedTeamPage({ slug }: { slug: string }) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const deleted = useDeletedTeams(true);
  const restore = useRestoreTeam();
  const home = () => navigate("/");

  if (deleted.isPending) return <div aria-busy="true" />;
  if (deleted.isError)
    return (
      <PageState
        code={toCloudError(deleted.error).code}
        onRetry={() => void deleted.refetch()}
        onHome={home}
      />
    );
  const team = deleted.data.find((row) => row.slug === slug);
  if (!team) return <PageState kind="notFound" onHome={home} />;

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
    team.purgeAtMs ?? undefined,
  );
  const run = async () => {
    try {
      await restore.mutateAsync(team.teamId);
      toast.success(t("cloud.team.restored"));
      navigate(spacePath({ team: team.slug }), { replace: true });
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };
  return (
    <div className="flex min-h-[60dvh]">
      <EmptyState
        icon={<Trash2 aria-hidden />}
        title={t("cloud.team.deletedAlert", { date })}
        headingLevel={1}
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => void run()} loading={restore.isPending}>
            {t("cloud.team.restore")}
          </Button>
          <Button variant="outline" onClick={home}>
            {t("cloud.page.home")}
          </Button>
        </div>
      </EmptyState>
    </div>
  );
}
