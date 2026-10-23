import { useT } from "@/app/preferences-store";
import type { RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { useTeamSpace } from "./data";
import { MembersPage } from "./MembersPage";
import { OverviewPage } from "./OverviewPage";
import { SettingsPage } from "./SettingsPage";

/**
 * `/t/:team/*` 的页面（云端控制台 §3.3）：概览、成员与邀请、设置；其余页（主机、授予、审计…）
 * 由各自的批次接上，这之前只有页头。团队的名字、角色、计划取自 `me.spaces`（外壳已经取过）。
 */
export function TeamPage({ match }: { match: RouteMatch }) {
  const t = useT();
  const found = useTeamSpace(match.params.team);
  const header = <PageHeader title={t(`cloud.nav.${match.nav ?? ""}`)} />;
  if (!found.team) return header;
  const { space, name, role, plan } = found.team;
  switch (match.id) {
    case "team":
      return <OverviewPage space={space} role={role} plan={plan} />;
    case "teamMembers":
      return (
        <MembersPage match={match} space={space} teamName={name} role={role} />
      );
    case "teamSettings":
      return <SettingsPage space={space} teamName={name} role={role} />;
    default:
      return header;
  }
}
