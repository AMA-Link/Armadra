import { Pencil, RefreshCw, ShieldCheck } from "lucide-react";
import type { SshHost } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { sshHostTarget } from "../../ssh-hosts";
import { SettingsTableCard } from "../../SettingsTableCard";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { Spinner } from "@/ui/spinner";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/** 一台主机上次验证的结论：胶囊的色调与已本地化的文案。 */
export interface WorkerStatus {
  tone: StatusTone;
  label: string;
}

export interface MachinesTableProps {
  hosts: readonly SshHost[];
  /** 表格卡标题（已本地化）；缺省是「主机」。 */
  title?: string;
  /** 正在验证的那一台；`null` 是没有。 */
  validating: string | null;
  /** 正在重新同步的那一台；`null` 是没有。 */
  resyncing?: string | null;
  /** 主机 id → 上次验证的结论；还没验证过的没有条目。 */
  workerStatus?: Readonly<Record<string, WorkerStatus | undefined>>;
  onValidate: (hostId: string) => void;
  onResync?: (hostId: string) => void;
  onOpen: (hostId: string) => void;
  /** 窄屏：一台一张 `Item`，不画表格。 */
  compact?: boolean;
}

/**
 * SSH 主机表卡：名称 · 地址（等宽）· Worker 状态胶囊 · 操作（验证 / 重新同步 / 打开）。
 * 点名称与「打开」进这台主机的子页；重新同步只给配了 Worker 的主机。纯展示：数据与动作
 * 都由调用方给，展示页用假数据渲染同一个组件。
 */
export function MachinesTable({
  hosts,
  title,
  validating,
  resyncing = null,
  workerStatus = {},
  onValidate,
  onResync,
  onOpen,
  compact = false,
}: MachinesTableProps) {
  const t = useT();
  const busy = validating !== null || resyncing !== null;
  const name = (host: SshHost) => (
    <Button
      type="button"
      variant="link"
      data-roving-item
      className="h-auto max-w-64 justify-start truncate p-0 font-medium text-foreground"
      onClick={() => onOpen(host.id)}
    >
      {host.name || host.id}
    </Button>
  );
  const status = (host: SshHost) => {
    const entry = workerStatus[host.id];
    return entry ? (
      <StatusPill size="sm" tone={entry.tone} label={entry.label} />
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  };
  const action = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled: boolean,
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          size="inline"
          label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {icon}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  const actions = (host: SshHost) => (
    <div className="flex items-center justify-end gap-0.5">
      {action(
        t("executionHosts.validate"),
        validating === host.id ? <Spinner aria-hidden /> : <ShieldCheck />,
        () => onValidate(host.id),
        busy,
      )}
      {host.worker &&
        onResync &&
        action(
          t("executionHosts.resync"),
          resyncing === host.id ? <Spinner aria-hidden /> : <RefreshCw />,
          () => onResync(host.id),
          busy,
        )}
      {action(
        t("executionHosts.open"),
        <Pencil />,
        () => onOpen(host.id),
        false,
      )}
    </div>
  );

  if (compact) {
    return (
      <ItemGroup className="gap-2">
        {hosts.map((host) => (
          <Item key={host.id} variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{name(host)}</ItemTitle>
              <span className="truncate font-mono text-meta text-muted-foreground">
                {sshHostTarget(host)}
              </span>
            </ItemContent>
            <ItemActions>
              {status(host)}
              {actions(host)}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    );
  }

  return (
    <SettingsTableCard title={title ?? t("executionHosts.table")}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("executionHosts.column.name")}</TableHead>
            <TableHead>{t("executionHosts.column.address")}</TableHead>
            <TableHead>{t("executionHosts.column.worker")}</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">
                {t("executionHosts.column.actions")}
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => (
            <TableRow key={host.id}>
              <TableCell>{name(host)}</TableCell>
              <TableCell className="max-w-64 truncate font-mono text-meta text-muted-foreground">
                {sshHostTarget(host)}
              </TableCell>
              <TableCell>{status(host)}</TableCell>
              <TableCell>{actions(host)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsTableCard>
  );
}
