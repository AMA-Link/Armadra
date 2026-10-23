import * as React from "react";

import { useT } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { Button } from "@/ui/button";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { StatusPill } from "@/ui/status-pill";
import { toast } from "@/ui/toast";
import { describeFailure } from "../api/errors";
import { PageHeader } from "../shell/PageHeader";
import { DataList, type DataColumn } from "../ui/DataList";
import { TypedConfirm } from "../ui/TypedConfirm";
import { OpsError } from "./common";
import { useDrainNode, useRelayNodes, type RelayNode } from "./data";

/** 节点 `/ops/nodes`（云端控制台 §3.4.2）：中继节点与排空；15 秒轮询。 */
export function NodesPage() {
  const t = useT();
  const nodes = useRelayNodes();
  const drain = useDrainNode();
  const [target, setTarget] = React.useState<string | null>(null);

  const columns = React.useMemo<DataColumn<RelayNode>[]>(
    () => [
      {
        id: "node",
        header: t("cloud.ops.node"),
        role: "primary",
        cell: (row) => <span translate="no">{row.node}</span>,
      },
      {
        id: "region",
        header: t("cloud.ops.region"),
        cell: (row) => row.region ?? null,
      },
      {
        id: "tunnels",
        header: t("cloud.ops.tunnels"),
        numeric: true,
        cell: (row) => row.tunnels,
      },
      {
        id: "connections",
        header: t("cloud.ops.connections"),
        numeric: true,
        cell: (row) => row.connections,
      },
      {
        id: "status",
        header: t("cloud.ops.status"),
        role: "trailing",
        cell: (row) =>
          !row.online ? (
            <StatusPill tone="idle" label={t("cloud.ops.down")} />
          ) : row.draining ? (
            <StatusPill tone="attention" label={t("cloud.ops.draining")} />
          ) : (
            <StatusPill tone="done" label={t("cloud.ops.serving")} />
          ),
      },
      {
        id: "heartbeat",
        header: t("cloud.ops.heartbeat"),
        cell: (row) =>
          row.lastSeenAtMs === null
            ? null
            : formatRelativeTime(row.lastSeenAtMs),
      },
    ],
    [t],
  );

  const rows = nodes.data?.nodes ?? [];
  return (
    <>
      <PageHeader title={t("cloud.nav.nodes")} />
      {nodes.isPending ? (
        <SkeletonTable rows={4} columns={6} />
      ) : nodes.isError ? (
        <OpsError error={nodes.error} onRetry={() => void nodes.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("cloud.ops.noNodes")} />
      ) : (
        <DataList
          caption={t("cloud.nav.nodes")}
          rows={rows}
          columns={columns}
          rowKey={(row) => row.node}
          actionsHeader={t("cloud.ops.drain")}
          actions={(row) =>
            row.online && !row.draining ? (
              <Button
                size="sm"
                variant="outline"
                aria-label={`${t("cloud.ops.drain")} ${row.node}`}
                onClick={() => setTarget(row.node)}
              >
                {t("cloud.ops.drain")}
              </Button>
            ) : null
          }
        />
      )}
      {target ? (
        <TypedConfirm
          open
          reason
          onOpenChange={(open) => !open && setTarget(null)}
          title={t("cloud.ops.drainTitle", { node: target })}
          expected={target}
          actionLabel={t("cloud.ops.drain")}
          onConfirm={async (reason) => {
            try {
              await drain.mutateAsync({ node: target, reason });
              toast.success(t("cloud.ops.drained", { node: target }));
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
