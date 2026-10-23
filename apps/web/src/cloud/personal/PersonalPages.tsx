import { useT } from "@/app/preferences-store";
import { HostDetail } from "../hosts/HostDetail";
import { HostDirectory } from "../hosts/HostDirectory";
import { LinksView } from "../links/LinksView";
import type { RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { PERSONAL_SPACE } from "../space";

/** `/me/*` 的页面（云端控制台 §3.2）；还没做的页面只有页头。 */
export function PersonalPage({ match }: { match: RouteMatch }) {
  const t = useT();
  switch (match.id) {
    case "meHosts":
      return (
        <>
          <PageHeader title={t("cloud.nav.hosts")} />
          <HostDirectory space={PERSONAL_SPACE} match={match} />
        </>
      );
    case "meHost":
      return <HostDetail space={PERSONAL_SPACE} match={match} />;
    case "meLinks":
      return (
        <>
          <PageHeader title={t("cloud.nav.links")} />
          <LinksView space={PERSONAL_SPACE} />
        </>
      );
    default:
      return <PageHeader title={t(`cloud.nav.${match.nav ?? ""}`)} />;
  }
}
