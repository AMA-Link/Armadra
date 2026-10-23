import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";

import { localRuntimeApi } from "@/api/client";

import { useAgentsQuery } from "../../../app/use-agents";
import {
  usePreferencesStore,
  useT,
  type AgentMode,
} from "../../../app/preferences-store";
import { InstallButton, useInstallJob } from "@/acp/adapter-install";
import { SettingsKpi, SettingsKpiGrid } from "../SettingsKpi";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsTableCard } from "../SettingsTableCard";
import { parseSubpage, useSubpage } from "../subpage";
import { AgentDetailPage, AgentModeSelect } from "./AgentDetailPage";
import type { AgentIntegration } from "./integration/types";
import {
  integrationKey,
  useAgentIntegration,
  useIntegrationRefresh,
} from "./integration/use-integration";
import {
  canvasAgentsValue,
  useIntegrationActions,
  useMigrationNotice,
} from "./integration/parts";
import { toast } from "@/ui/toast";
import { Button } from "@/ui/button";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

/** 一家 CLI 在这台主机上的状态；`ready` 时主表上不画徽标。 */
export type AgentState =
  | "ready"
  | "installNeeded"
  | "updateNeeded"
  | "disabled";

/**
 * 主表一行的状态（§2.5）：禁用优先，其次没装，再次注入产物要重新生成。
 * 集成状态还没读回来时按「可用」算，读回来再换。
 */
export function agentState(
  agent: AgentInfo,
  integration: AgentIntegration | null,
  mode: AgentMode,
): AgentState {
  if (mode === "disabled") return "disabled";
  if (!agent.installed) return "installNeeded";
  if (
    integration &&
    agent.capabilities.includes("hooks") &&
    (integration.stale ||
      !integration.hook.installed ||
      !integration.skill.installed)
  )
    return "updateNeeded";
  return "ready";
}

/** 状态 → 胶囊色调（表格列对齐优先：就绪也出现胶囊）。 */
export const AGENT_STATE_TONE: Record<AgentState, StatusTone> = {
  ready: "done",
  installNeeded: "attention",
  updateNeeded: "attention",
  disabled: "paused",
};

/** 状态胶囊的文案键：就绪与另三态不在同一个前缀下。 */
export function agentStateLabelKey(state: AgentState): string {
  return state === "ready" ? "settings.kpi.ready" : `agents.state.${state}`;
}

/** 三态计数：「就绪 / 需安装 / 需更新」（禁用的不计入任何一张）。 */
export function countAgentStates(
  states: readonly AgentState[],
): Record<"ready" | "installNeeded" | "updateNeeded", number> {
  const count = (state: AgentState) =>
    states.filter((entry) => entry === state).length;
  return {
    ready: count("ready"),
    installNeeded: count("installNeeded"),
    updateNeeded: count("updateNeeded"),
  };
}

/**
 * 三张 KPI 托盘（纯展示）：大数字 = 计数，刻度 = n / 总数；就绪走成功色，另两张走警告色。
 */
export function AgentsKpis({
  counts,
  total,
}: {
  counts: Record<"ready" | "installNeeded" | "updateNeeded", number>;
  total: number;
}) {
  const t = useT();
  const cards = [
    { key: "ready", tone: "success" },
    { key: "installNeeded", tone: "warn" },
    { key: "updateNeeded", tone: "warn" },
  ] as const;
  return (
    <SettingsKpiGrid>
      {cards.map(({ key, tone }) => (
        <SettingsKpi
          key={key}
          label={t(`settings.kpi.${key}`)}
          value={counts[key]}
          percent={total > 0 ? (counts[key] / total) * 100 : 0}
          tone={tone}
          meta={
            <span className="font-mono">{`${counts[key]} / ${total}`}</span>
          }
        />
      ))}
    </SettingsKpiGrid>
  );
}

/** 表格一行（纯展示）：动作位是调用方给的节点（安装 / 更新 / 三态选择）。 */
export interface AgentsTableRowData {
  agent: Pick<AgentInfo, "id" | "label">;
  state: AgentState;
  /** 画布视图的文字；没有写 `—`。 */
  views: string;
  action: React.ReactNode;
  onOpen?: () => void;
}

/** 表格的一行（纯展示）。 */
export function AgentTableRow({ row }: { row: AgentsTableRowData }) {
  const t = useT();
  return (
    <TableRow data-agent-id={row.agent.id}>
      <TableCell className="font-medium">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-roving-item
          className="-ml-1.5 font-medium"
          onClick={row.onOpen}
        >
          {row.agent.label}
        </Button>
      </TableCell>
      <TableCell>
        <StatusPill
          size="sm"
          tone={AGENT_STATE_TONE[row.state]}
          label={t(agentStateLabelKey(row.state))}
          data-agent-state={row.state}
        />
      </TableCell>
      <TableCell className="hidden text-muted-foreground sm:table-cell">
        {row.views}
      </TableCell>
      <TableCell>
        <div className="flex justify-end">{row.action}</div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Agent CLI 表格卡（纯展示）：名称 · 状态胶囊 · 画布视图 · 动作。没有筛选；行主动作（名称）
 * 标 `data-roving-item`，↑↓ 在行间移动；没有数据时卡内一句空态；`loading` 出骨架。
 */
export function AgentsTableCard({
  rows,
  loading = false,
}: {
  rows: readonly AgentsTableRowData[];
  loading?: boolean;
}) {
  const t = useT();
  return (
    <SettingsTableCard
      title={t("settings.group.agent")}
      loading={loading}
      skeleton={{ rows: 4, columns: 4 }}
      empty={rows.length === 0 ? { title: t("integration.empty") } : null}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("agents.col.name")}</TableHead>
            <TableHead>{t("agents.col.state")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("agents.col.views")}
            </TableHead>
            <TableHead>
              <span className="sr-only">{t("agents.col.action")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <AgentTableRow key={row.agent.id} row={row} />
          ))}
        </TableBody>
      </Table>
    </SettingsTableCard>
  );
}

/** 一家的「画布视图」文字：不能在画布里创建时写 `—`。 */
export function agentViews(
  t: ReturnType<typeof useT>,
  integration: AgentIntegration | null,
): string {
  const spawn = canvasAgentsValue(integration?.canvasAgents);
  return spawn === null || spawn === "none"
    ? "—"
    : t(`integration.canvasAgents.${spawn}`);
}

/** 动作位：没装且能代装 → 安装；注入待更新 → 更新；其余是启用 / 默认 / 禁用三态选择。 */
export function AgentActionCell({
  agent,
  state,
}: {
  agent: AgentInfo;
  state: AgentState;
}) {
  const t = useT();
  const { integration } = useAgentIntegration(agent);
  const cli = useInstallJob(agent, "cli");
  const { regenerate, busy } = useIntegrationActions(agent);
  useMigrationNotice(agent, integration);
  if (state === "installNeeded" && cli.available)
    return <InstallButton install={cli} installed={false} />;
  if (state === "updateNeeded")
    return (
      <Button
        variant="secondary"
        size="xs"
        disabled={busy && !regenerate.isPending}
        loading={regenerate.isPending}
        onClick={() => regenerate.mutate()}
      >
        {t("agents.action.update")}
      </Button>
    );
  return <AgentModeSelect agent={agent} size="xs" />;
}

/** 一家一行，读缓存里的集成状态（展示页用假数据填缓存后渲染它；放进 `Table` 的 `TableBody`）。 */
export function AgentRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const subpage = useSubpage();
  const { integration } = useAgentIntegration(agent);
  const mode = usePreferencesStore(
    (state) => state.agentModes[agent.id] ?? "default",
  );
  const state = agentState(agent, integration, mode);
  return (
    <AgentTableRow
      row={{
        agent,
        state,
        views: agentViews(t, integration),
        action: <AgentActionCell agent={agent} state={state} />,
        onOpen: () => subpage.open("cli", agent.id),
      }}
    />
  );
}

/**
 * 页头「重新生成注入」：对每家装了、支持 Hook 的 CLI 重新生成画布注入产物，完成后刷新各家
 * 状态。失败弹一条错误。
 */
function useRegenerateAll(agents: readonly AgentInfo[]) {
  const t = useT();
  const refresh = useIntegrationRefresh();
  const [pending, setPending] = React.useState(false);
  const targets = agents.filter(
    (agent) => agent.installed && agent.capabilities.includes("hooks"),
  );
  const run = async () => {
    setPending(true);
    try {
      await Promise.all(
        targets.map((agent) =>
          localRuntimeApi.installAgentIntegration(agent.id),
        ),
      );
    } catch (cause) {
      toast.error(t("integration.failed"), {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      for (const agent of targets) refresh(agent.id);
      setPending(false);
    }
  };
  return { run, pending, disabled: targets.length === 0 };
}

/**
 * 设置 → Agent CLI（§2.5）。
 *
 * 页头一个「重新生成注入」；三张托盘数就绪 / 需安装 / 需更新；主体是表格卡，一家一行：
 * 名称 · 状态 · 能在画布里用哪种视图 · 一个动作；点名称进这一家的子页看安装与注入的细节。
 * 自定义 Agent 在自己那一页。
 */
export function AgentsPage() {
  const t = useT();
  const agents = useAgentsQuery("local");
  const subpage = parseSubpage(useSubpage().current);
  const modes = usePreferencesStore((state) => state.agentModes);
  const open = useSubpage().open;
  const builtins = React.useMemo(
    () => (agents.data ?? []).filter((agent) => !agent.baseAgent),
    [agents.data],
  );
  // 与导航徽标、行内动作同一份缓存：键一致，一家一次请求。
  const integrations = useQueries({
    queries: builtins.map((agent) => ({
      queryKey: integrationKey(agent.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        localRuntimeApi.agentIntegration(agent.id, signal),
    })),
  });
  const regenerateAll = useRegenerateAll(builtins);

  if (subpage?.kind === "cli") {
    const agent = builtins.find((entry) => entry.id === subpage.ref);
    if (agent) return <AgentDetailPage agent={agent} />;
  }

  const rows: AgentsTableRowData[] = builtins.map((agent, index) => {
    const integration = integrations[index]?.data ?? null;
    const state = agentState(agent, integration, modes[agent.id] ?? "default");
    return {
      agent,
      state,
      views: agentViews(t, integration),
      action: <AgentActionCell agent={agent} state={state} />,
      onOpen: () => open("cli", agent.id),
    };
  });
  const counts = countAgentStates(rows.map((row) => row.state));

  return (
    <>
      <SettingsPageHeader
        actions={
          <Button
            variant="outline"
            size="sm"
            loading={regenerateAll.pending}
            disabled={regenerateAll.disabled}
            onClick={() => void regenerateAll.run()}
          >
            {t("agents.action.regenerateAll")}
          </Button>
        }
      />
      {builtins.length > 0 && (
        <AgentsKpis counts={counts} total={builtins.length} />
      )}
      <AgentsTableCard rows={rows} loading={agents.isPending} />
    </>
  );
}
