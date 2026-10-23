import { Activity, Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";
import type { HostResources } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import {
  UNKNOWN,
  diskUsedPercent,
  formatMetricBytes,
  formatPercent,
  formatUptime,
  memoryUsedPercent,
} from "@/panels/resources/metrics";
import { SettingsKpi, SettingsKpiGrid } from "../SettingsKpi";

/**
 * 本机服务页的 KPI 托盘（设计系统 §5.17）：CPU · 内存 · 磁盘 · 运行时长 · 活跃会话。
 *
 * 纯展示：数据都由调用方给，展示页用假数据渲染同一个组件。测不出来的指标是 `null`，
 * 显示 `—` 且不画刻度（`null` 是一个值，不是 0）；CPU、内存、磁盘的刻度按 80 / 95 阈值
 * 变色，运行时长与会话数没有刻度。
 */
export function ServiceKpis({
  resources,
  liveSessions,
}: {
  /** 主机采样；还没有样本时 `null`。 */
  resources: HostResources | null;
  /** 活跃会话数（`liveSessions()` 的长度）；还没有样本时 `null`。 */
  liveSessions: number | null;
}) {
  const t = useT();
  const cpu = resources?.cpuPercent ?? null;
  const memory = resources ? memoryUsedPercent(resources) : null;
  const disk = resources ? diskUsedPercent(resources) : null;
  return (
    <SettingsKpiGrid>
      <SettingsKpi
        icon={<Cpu />}
        label={t("resources.host.cpu")}
        value={cpu}
        format={formatPercent}
        percent={cpu}
        meta={
          typeof resources?.cpuCores === "number"
            ? t("resources.host.cores", { count: resources.cpuCores })
            : undefined
        }
      />
      <SettingsKpi
        icon={<MemoryStick />}
        label={t("resources.host.memory")}
        value={memory}
        format={formatPercent}
        percent={memory}
        meta={
          resources
            ? `${formatMetricBytes(resources.memory.availableBytes)} / ${formatMetricBytes(
                resources.memory.totalBytes,
              )}`
            : undefined
        }
      />
      <SettingsKpi
        icon={<HardDrive />}
        label={t("resources.host.disk")}
        value={disk}
        format={formatPercent}
        percent={disk}
        meta={
          resources?.disk
            ? `${formatMetricBytes(resources.disk.availableBytes)} / ${formatMetricBytes(
                resources.disk.totalBytes,
              )}`
            : undefined
        }
      />
      <SettingsKpi
        icon={<Clock />}
        label={t("host.kpi.uptime")}
        value={
          resources
            ? formatUptime(resources.uptimeSeconds, {
                day: t("host.uptime.day"),
                hour: t("host.uptime.hour"),
                minute: t("host.uptime.minute"),
              })
            : UNKNOWN
        }
      />
      <SettingsKpi
        icon={<Activity />}
        label={t("host.kpi.sessions")}
        value={liveSessions}
      />
    </SettingsKpiGrid>
  );
}
