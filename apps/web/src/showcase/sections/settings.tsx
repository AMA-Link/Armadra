import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useT } from "@/app/preferences-store";
import {
  SETTINGS_SECTIONS,
  groupSections,
  settingsSection,
} from "@/panels/settings/nav";
import { SettingsPageContext } from "@/panels/settings/page-context";
import {
  AgentsKpis,
  AgentsTableCard,
  agentState,
  agentViews,
  countAgentStates,
  type AgentsTableRowData,
} from "@/panels/settings/pages/AgentsPage";
import { AgentModeSelect } from "@/panels/settings/pages/AgentDetailPage";
import { ServiceKpis } from "@/panels/settings/pages/ServiceKpis";
import { UsageKpis } from "@/panels/settings/pages/UsageKpis";
import { SOURCES_QUERY_KEY } from "@/panels/settings/pages/remote-access/keys";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsNav } from "@/panels/settings/SettingsNav";
import { SettingsPageHeader } from "@/panels/settings/SettingsPageHeader";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { SettingsSearch } from "@/panels/settings/SettingsSearch";
import { SettingsTableCard } from "@/panels/settings/SettingsTableCard";
import { SettingsTopbar } from "@/panels/settings/SettingsTopbar";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";
import { useCompactLayout } from "@/platform/layout";
import { IconButton } from "@/ui/icon-button";
import { X } from "lucide-react";
import { CLI_GROUP } from "../fixtures/integration";
import {
  NAV_BADGES,
  NOW,
  SERVICE_RESOURCES,
  SERVICE_RESOURCES_UNKNOWN,
  USAGE_PROVIDERS,
} from "../fixtures/settings";
import { Sample } from "./sample";

const noop = () => undefined;

/** 一页的内容面板：与真的设置对话框同一块 `Card`（16 圆角、1px 边）。 */
function Panel({
  sectionId,
  children,
}: {
  sectionId: string;
  children: React.ReactNode;
}) {
  return (
    <SettingsPageContext.Provider value={{ sectionId, query: "" }}>
      <Card className="gap-(--space-section) rounded-float p-3 md:p-(--space-section)">
        {children}
      </Card>
    </SettingsPageContext.Provider>
  );
}

/** 外壳：真的导航、顶栏与搜索，右侧面板里是「用量」页。 */
function Shell() {
  const t = useT();
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [active, setActive] = React.useState("usage");
  const groups = React.useMemo(() => groupSections(SETTINGS_SECTIONS), []);
  const section = settingsSection(active);
  const compact = useCompactLayout();
  const search = (
    <SettingsSearch
      query={query}
      onQueryChange={setQuery}
      sectionIds={SETTINGS_SECTIONS.map((entry) => entry.id)}
      onPick={(hit) => {
        setActive(hit.sectionId);
        setQuery("");
      }}
      inputRef={inputRef}
    />
  );
  return (
    <div
      data-testid="settings-shell"
      data-compact={compact ? "true" : undefined}
      className={`settings-layout flex h-[640px] w-full overflow-hidden rounded-dialog border border-border-strong bg-background material-backdrop ${compact ? "flex-col p-3" : ""}`}
    >
      {compact ? (
        <div className="flex shrink-0 flex-col gap-2 pb-2">
          <div className="flex items-center gap-2">
            <Select value={active} onValueChange={setActive}>
              <SelectTrigger
                aria-label={t("settings.title")}
                className="min-w-0 flex-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groups.flatMap((group) =>
                  group.sections.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {t(entry.labelKey)}
                    </SelectItem>
                  )),
                )}
              </SelectContent>
            </Select>
            <IconButton size="cluster" label={t("tab.close")} onClick={noop}>
              <X />
            </IconButton>
          </div>
          {search}
        </div>
      ) : (
        <SettingsNav
          groups={groups}
          active={active}
          onSelect={setActive}
          badges={NAV_BADGES}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!compact && (
          <SettingsTopbar
            section={section}
            subpage={null}
            onClose={noop}
            search={search}
          />
        )}
        <Card
          className={`min-h-0 flex-1 gap-0 overflow-y-auto rounded-float py-0 ${compact ? "" : "mr-4 mb-4"}`}
        >
          <SettingsPageContext.Provider value={{ sectionId: active, query }}>
            <div className="flex flex-col gap-(--space-section) p-3 md:p-(--space-section)">
              <SettingsPageHeader
                actions={
                  active === "usage" ? (
                    <>
                      <Button variant="outline" size="sm">
                        {t("usage.refresh")}
                      </Button>
                      <Button variant="outline" size="sm">
                        {t("usage.dashboard.open")}
                      </Button>
                    </>
                  ) : undefined
                }
              />
              {active === "usage" && (
                <>
                  <UsageKpis providers={USAGE_PROVIDERS} now={NOW} />
                  <SettingsGroup>
                    <SettingsRow label={t("settings.usageEnabled")}>
                      <Switch
                        defaultChecked
                        aria-label={t("settings.usageEnabled")}
                      />
                    </SettingsRow>
                    <SettingsRow label={t("settings.usageCadence")}>
                      <Select defaultValue="5">
                        <SelectTrigger
                          size="sm"
                          aria-label={t("settings.usageCadence")}
                          className="w-32"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="5">
                            {t("settings.cadence.minutes", { count: 5 })}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingsRow>
                  </SettingsGroup>
                </>
              )}
            </div>
          </SettingsPageContext.Provider>
        </Card>
      </div>
    </div>
  );
}

/** 「Agent CLI」页：三张托盘 + 表格卡，行取自 `integration` 分区的同一份假数据。 */
function AgentsSample() {
  const t = useT();
  const rows: AgentsTableRowData[] = CLI_GROUP.map(({ agent, integration }) => {
    const state = agentState(agent, integration, "default");
    return {
      agent,
      state,
      views: agentViews(t, integration),
      action:
        state === "updateNeeded" ? (
          <Button variant="secondary" size="xs">
            {t("agents.action.update")}
          </Button>
        ) : (
          <AgentModeSelect agent={agent} size="xs" />
        ),
    };
  });
  const counts = countAgentStates(rows.map((row) => row.state));
  return (
    <Panel sectionId="agents">
      <SettingsPageHeader
        actions={
          <Button variant="outline" size="sm">
            {t("agents.action.regenerateAll")}
          </Button>
        }
      />
      <AgentsKpis counts={counts} total={rows.length} />
      <AgentsTableCard rows={rows} />
    </Panel>
  );
}

/** 「本机服务」页：托盘（有值 / 全是 `—`）。 */
function ServiceSample() {
  return (
    <Panel sectionId="service">
      <SettingsPageHeader />
      <ServiceKpis resources={SERVICE_RESOURCES} liveSessions={4} />
      <ServiceKpis resources={SERVICE_RESOURCES_UNKNOWN} liveSessions={null} />
    </Panel>
  );
}

/** 表格卡的空态与骨架。 */
function TableStates() {
  const t = useT();
  return (
    <div className="grid w-full gap-4 md:grid-cols-2">
      <SettingsTableCard
        title={t("settings.group.agent")}
        empty={{ title: t("integration.empty") }}
      />
      <SettingsTableCard
        title={t("settings.group.agent")}
        loading
        skeleton={{ rows: 4, columns: 4 }}
      />
    </div>
  );
}

/**
 * `settings` 分区（设计展示页 §2.1，设计系统 §5.17）：设置工作台。外壳（真的导航、顶栏、
 * 搜索与内容面板，用量页）+「Agent CLI」「本机服务」两页的假数据（托盘、表格卡），再加
 * 表格卡的空态与骨架。本分区没有 core：query 缓存预先放好，不去请求。
 */
export default function SettingsSection() {
  const client = useQueryClient();
  // 顶栏的作用范围徽标会读源表：渲染之前放一份空表，不发请求。
  React.useState(() => {
    client.setQueryDefaults(SOURCES_QUERY_KEY, { staleTime: Infinity });
    client.setQueryData(SOURCES_QUERY_KEY, { sources: [] });
    return true;
  });
  return (
    <div className="flex flex-col gap-8">
      <Sample name="settings-shell" full>
        <Shell />
      </Sample>
      <Sample name="settings-agents" full>
        <div className="w-full">
          <AgentsSample />
        </div>
      </Sample>
      <Sample name="settings-service" full>
        <div className="w-full">
          <ServiceSample />
        </div>
      </Sample>
      <Sample name="settings-table-states" full>
        <TableStates />
      </Sample>
    </div>
  );
}
