import * as React from "react";

import { useT } from "@/app/preferences-store";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { SkeletonSettingsRow } from "@/ui/skeletons";
import { Switch } from "@/ui/switch";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { PageHeader } from "../shell/PageHeader";
import { TypedConfirm } from "../ui/TypedConfirm";
import { OpsError } from "./common";
import { useIncident, useSetIncident, type Incident } from "./data";

type Field = "pauseAssertions" | "pauseRegistrations" | "rejectNewConnections";

/** 开关「开」= 正常 = 对应字段为 false（云端控制台 §3.4.3）；关掉要理由与输入开关名。 */
const SWITCHES = [
  {
    id: "issueAccess",
    field: "pauseAssertions",
    label: "cloud.ops.issueAccess",
    pause: "cloud.ops.issueAccessPause",
    pauseTitle: "cloud.ops.issueAccessTitle",
    resumeTitle: "cloud.ops.issueAccessResumeTitle",
  },
  {
    id: "signups",
    field: "pauseRegistrations",
    label: "cloud.ops.signups",
    pause: "cloud.ops.signupsPause",
    pauseTitle: "cloud.ops.signupsTitle",
    resumeTitle: "cloud.ops.signupsResumeTitle",
  },
  {
    id: "newConnections",
    field: "rejectNewConnections",
    label: "cloud.ops.newConnections",
    pause: "cloud.ops.newConnectionsPause",
    pauseTitle: "cloud.ops.newConnectionsTitle",
    resumeTitle: "cloud.ops.newConnectionsResumeTitle",
  },
] as const satisfies readonly {
  id: string;
  field: Field;
  label: string;
  pause: string;
  pauseTitle: string;
  resumeTitle: string;
}[];

type SwitchDef = (typeof SWITCHES)[number];

const isOn = (incident: Incident, field: Field) => incident[field] !== true;

/** 服务状态 `/ops/status`（云端控制台 §3.4.3）：M1 只有事故开关。 */
export function StatusPage() {
  const t = useT();
  const incident = useIncident();
  const save = useSetIncident();
  const [pending, setPending] = React.useState<{
    def: SwitchDef;
    turnOn: boolean;
  } | null>(null);

  return (
    <>
      <PageHeader title={t("cloud.nav.status")} />
      {incident.isPending ? (
        <SettingsGroup title={t("cloud.ops.incident")}>
          {SWITCHES.map((def, index) => (
            <SkeletonSettingsRow key={def.id} control="switch" index={index} />
          ))}
        </SettingsGroup>
      ) : incident.isError ? (
        <OpsError
          error={incident.error}
          onRetry={() => void incident.refetch()}
        />
      ) : (
        <SettingsGroup title={t("cloud.ops.incident")}>
          {SWITCHES.map((def) => (
            <SettingsRow key={def.id} label={t(def.label)}>
              <Switch
                aria-label={t(def.label)}
                checked={isOn(incident.data, def.field)}
                onCheckedChange={(next) => setPending({ def, turnOn: next })}
              />
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
      {pending ? (
        <TypedConfirm
          open
          reason
          onOpenChange={(open) => !open && setPending(null)}
          title={t(
            pending.turnOn ? pending.def.resumeTitle : pending.def.pauseTitle,
          )}
          expected={t(pending.def.label)}
          actionLabel={t(
            pending.turnOn ? "cloud.ops.resume" : pending.def.pause,
          )}
          onConfirm={async (reason) => {
            try {
              await save.mutateAsync({
                [pending.def.field]: !pending.turnOn,
                reason,
              });
              toast.success(
                t("cloud.ops.incidentDone", { name: t(pending.def.label) }),
              );
            } catch (failure) {
              toast.error(describeFailure(failure));
              throw failure;
            }
          }}
        />
      ) : null}
    </>
  );
}
