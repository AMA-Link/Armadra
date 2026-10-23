import { useT } from "@/app/preferences-store";
import type { RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import { NodesPage } from "./NodesPage";
import { StatusPage } from "./StatusPage";
import { TenantsPage } from "./TenantsPage";

/** `/ops/*` 的页面（云端控制台 §3.4）；M2 的滥用与功能开关还只有页头。 */
export function OpsPage({ match }: { match: RouteMatch }) {
  const t = useT();
  switch (match.id) {
    case "ops":
    case "opsTenant":
      return <TenantsPage match={match} />;
    case "opsNodes":
      return <NodesPage />;
    case "opsStatus":
      return <StatusPage />;
    default:
      return <PageHeader title={t(`cloud.nav.${match.nav ?? ""}`)} />;
  }
}
