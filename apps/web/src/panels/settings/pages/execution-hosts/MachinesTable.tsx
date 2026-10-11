import type { SshHost } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { sshHostTarget } from "../../ssh-hosts";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/ui/item";
import { Spinner } from "@/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

export interface MachinesTableProps {
  hosts: readonly SshHost[];
  /** 正在验证的那一台；`null` 是没有。 */
  validating: string | null;
  onValidate: (hostId: string) => void;
  onOpen: (hostId: string) => void;
  /** 窄屏：一台一张 `Item`，不画表格。 */
  compact?: boolean;
}

/**
 * SSH 主机表：名称 · 地址 · 「验证」。点名称进这台主机的子页。纯展示：数据与
 * 动作都由调用方给，展示页用假数据渲染同一个组件。
 */
export function MachinesTable({
  hosts,
  validating,
  onValidate,
  onOpen,
  compact = false,
}: MachinesTableProps) {
  const t = useT();
  const validate = (host: SshHost) => (
    <Button
      size="sm"
      variant="secondary"
      disabled={validating !== null}
      onClick={() => onValidate(host.id)}
    >
      {validating === host.id && <Spinner aria-hidden />}
      {t("executionHosts.validate")}
    </Button>
  );
  const name = (host: SshHost) => (
    <Button
      type="button"
      variant="link"
      className="h-auto max-w-[16rem] justify-start truncate p-0 text-[13px] font-medium text-foreground"
      onClick={() => onOpen(host.id)}
    >
      {host.name || host.id}
    </Button>
  );

  if (compact) {
    return (
      <ItemGroup className="gap-2">
        {hosts.map((host) => (
          <Item key={host.id} variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{name(host)}</ItemTitle>
              <ItemDescription className="truncate">
                {sshHostTarget(host)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>{validate(host)}</ItemActions>
          </Item>
        ))}
      </ItemGroup>
    );
  }

  return (
    <Card className="gap-0 overflow-visible rounded-lg border border-border/70 px-2 py-0 text-[length:inherit] ring-0">
      <Table className="text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead>{t("executionHosts.column.name")}</TableHead>
            <TableHead>{t("executionHosts.column.address")}</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">{t("executionHosts.validate")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hosts.map((host) => (
            <TableRow key={host.id}>
              <TableCell>{name(host)}</TableCell>
              <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                {sshHostTarget(host)}
              </TableCell>
              <TableCell className="text-right">{validate(host)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
