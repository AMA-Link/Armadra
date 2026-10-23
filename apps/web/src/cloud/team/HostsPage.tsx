import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { HostDetail } from "../hosts/HostDetail";
import { HostDirectory } from "../hosts/HostDirectory";
import { RegisterHostDialog } from "../hosts/RegisterHostDialog";
import type { RouteMatch } from "../router";
import { PageHeader } from "../shell/PageHeader";
import type { TeamRole } from "../shell/model";
import { useTeamSettings, type TeamSpace } from "./data";

/** 登记主机：owner / admin 总是可以，member 要团队设置允许；guest 与 billing 不画（云端也答 `team_role_insufficient`）。 */
export function useCanRegister(space: TeamSpace, role: TeamRole): boolean {
  const settings = useTeamSettings(space, role === "member");
  if (role === "owner" || role === "admin") return true;
  return role === "member" && settings.data?.membersCanRegisterHosts === true;
}

/** `/t/:team/hosts`：页头带「登记主机」，目录复用个人空间的组件（状态与搜索进地址，游标分页）。 */
export function TeamHostsPage({
  match,
  space,
  role,
}: {
  match: RouteMatch;
  space: TeamSpace;
  role: TeamRole;
}) {
  const t = useT();
  const [registering, setRegistering] = React.useState(false);
  const canRegister = useCanRegister(space, role);
  const register = canRegister ? (
    <Button size="sm" onClick={() => setRegistering(true)}>
      {t("cloud.hosts.register")}
    </Button>
  ) : null;
  return (
    <>
      <PageHeader title={t("cloud.nav.hosts")} action={register} />
      <HostDirectory
        space={space}
        match={match}
        manager={role === "owner" || role === "admin"}
        emptyAction={
          canRegister ? (
            <Button onClick={() => setRegistering(true)}>
              {t("cloud.hosts.register")}
            </Button>
          ) : null
        }
      />
      {registering ? (
        <RegisterHostDialog
          space={space}
          onClose={() => setRegistering(false)}
        />
      ) : null}
    </>
  );
}

/** `/t/:team/hosts/:host`：团队主机详情（访问 · 链接 · 设置）。 */
export function TeamHostPage({
  match,
  space,
  name,
  role,
}: {
  match: RouteMatch;
  space: TeamSpace;
  name: string;
  role: TeamRole;
}) {
  return <HostDetail space={space} match={match} team={{ role, name }} />;
}
