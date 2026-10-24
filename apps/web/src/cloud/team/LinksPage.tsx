import { useT } from "@/app/preferences-store";
import { LinksView } from "../links/LinksView";
import { PageHeader } from "../shell/PageHeader";
import type { TeamSpace } from "./data";

/** `/t/:team/links`（云端控制台 §3.3.8）：团队全部链接，列表、改备注、撤销与个人空间同一个组件。 */
export function TeamLinksPage({ space }: { space: TeamSpace }) {
  const t = useT();
  return (
    <>
      <PageHeader title={t("cloud.nav.links")} />
      <LinksView space={space} />
    </>
  );
}
