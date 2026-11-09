import { useQueryClient } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";

import {
  agentIsEnabled,
  usePreferencesStore,
  useT,
} from "../../../app/preferences-store";
import {
  CopyCommandButton,
  InstallButton,
  InstallFailure,
  useInstallJob,
} from "@/acp/adapter-install";
import { SignOutButton, canSignOut } from "@/acp/SignOutButton";
import { attachable, openAttachSession } from "@/acp/attach-session";
import { currentViewportCenter } from "@/canvas/placement";
import { useCanvasStore } from "@/store/canvas-store";
import { ScopeBadge } from "../scope-badge";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { ValueLoadable } from "../SettingsLoadable";
import { SettingsRow } from "../SettingsRow";
import { useAgentIntegration } from "./integration/use-integration";
import { AmaKeys } from "./AmaKeys";
import {
  CleanupButton,
  RowValue,
  canvasAgentsValue,
  historyValue,
  injectionProblem,
  modsValue,
  useIntegrationActions,
  useMigrationNotice,
} from "./integration/parts";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";

/**
 * 启用开关（本设备，`agentModes`）：开 = 出现在画布右键等新建入口，关 = 不出现。
 * 主表、子页与自定义 Agent 表格同一个控件；关掉不删配置，也不动已有节点。
 *
 * `installed` 是本机检测；`undefined` = 检测结果还没到，此时开关不可点（按「没装」
 * 写会把本该是 `default` 的写成 `enabled`）。菜单按**当前来源**的检测过滤，所以从
 * 关到开时若当前来源（比如远端工作空间）报告没装，写 `enabled` 才进得了它的菜单。
 */
export function AgentEnabledSwitch({
  agent,
}: {
  agent: Pick<AgentInfo, "id" | "label"> & { installed: boolean | undefined };
}) {
  const t = useT();
  const client = useQueryClient();
  const detected = agent.installed !== undefined;
  const enabled = usePreferencesStore((state) =>
    agentIsEnabled(state.agentModes[agent.id], agent.installed ?? false),
  );
  const setAgentEnabled = usePreferencesStore((state) => state.setAgentEnabled);
  return (
    <Switch
      size="sm"
      checked={enabled}
      disabled={!detected}
      aria-label={`${agent.label} ${t("agents.row.mode")}`}
      onCheckedChange={(checked) => {
        // 当前来源的清单（与 `useAgentsQuery()` 同一个键）；没取到就只信本机检测。
        const here = client
          .getQueryData<readonly AgentInfo[]>(["agents"])
          ?.find((entry) => entry.id === agent.id);
        const installed =
          (agent.installed ?? false) && here?.installed !== false;
        setAgentEnabled(agent.id, checked, installed);
      }}
    />
  );
}

/**
 * Agent CLI 子页（§2.5）：启动 · 安装 · 画布注入三组。
 *
 * 画布注入只说数据目录里本产品的产物（Hook、技能、启动器），不读也不展示
 * CLI 配置里别的东西。「清理旧版」只在 core 报出本产品旧版本的条目时出现。
 */
export function AgentDetailPage({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const { integration } = useAgentIntegration(agent);
  const cli = useInstallJob(agent, "cli");
  const adapter = useInstallJob(agent, "adapter");
  const { regenerate, repair, busy } = useIntegrationActions(agent);
  useMigrationNotice(agent, integration);
  const override = usePreferencesStore(
    (state) => state.launchOverrides[agent.id] ?? "",
  );
  const setLaunchOverride = usePreferencesStore(
    (state) => state.setLaunchOverride,
  );
  // 「接管会话」：关掉的 Agent、没装的、没有打开的工作空间都不给入口。
  const enabled = usePreferencesStore((state) =>
    agentIsEnabled(state.agentModes[agent.id], agent.installed),
  );
  const workspace = useCanvasStore((state) => state.workspace);
  const canAttach =
    enabled &&
    workspace !== null &&
    Boolean(agent.resolvedPath) &&
    attachable(agent);
  const attach = () => {
    const canvas = useCanvasStore.getState();
    if (!canvas.workspace) return;
    // 对话框建节点要看着画布：先收起设置，落点是此刻的视口中心。
    canvas.setPanel("settings", false);
    openAttachSession(
      {
        addNode: canvas.addNode,
        position: currentViewportCenter(),
        workspace: canvas.workspace,
        agents: [agent],
      },
      agent,
    );
  };

  /* ---------------------------------- 安装 --------------------------------- */
  const version = agent.probe?.version;
  const cliValue = agent.installed
    ? version
      ? t("integration.state.installedVersion", { version })
      : t("integration.state.installed")
    : t("integration.state.cliMissing");
  const acp = agent.acp;
  const native = acp?.support === "native";
  const bundled = acp?.support === "bundled";
  const acpValue = !acp
    ? null
    : bundled
      ? t("integration.state.bundled")
      : native && agent.installed
        ? t("integration.state.viaCli")
        : acp.installed
          ? acp.version
            ? t("integration.state.installedVersion", { version: acp.version })
            : t("integration.state.installed")
          : t("integration.state.missing");

  /* -------------------------------- 画布注入 -------------------------------- */
  const hooked = agent.capabilities.includes("hooks");
  const problem = injectionProblem(t, integration);
  const limited = integration?.launcherWarning;
  const legacy = integration?.legacy.found ?? [];
  const spawn = canvasAgentsValue(integration?.canvasAgents);
  const reasons = integration?.canvasAgents?.reasons ?? [];
  const history = historyValue(t, agent.history);
  const mods = modsValue(t, integration?.mods);

  return (
    <>
      <SettingsPageHeader />
      <SettingsGroup title={t("agents.group.launch")}>
        <SettingsRow label={t("agents.row.mode")}>
          <ScopeBadge scope="device" />
          <AgentEnabledSwitch agent={agent} />
        </SettingsRow>
        {canAttach && (
          <SettingsRow label={t("agents.row.attach")}>
            <Button variant="secondary" size="sm" onClick={attach}>
              {t("agents.attach.pick")}
            </Button>
          </SettingsRow>
        )}
        <SettingsRow label={t("settings.launchCommand")}>
          <ScopeBadge scope="device" />
          <Input
            size="sm"
            className="w-36 sm:w-60"
            aria-label={`${agent.label} ${t("settings.launchCommand")}`}
            placeholder={agent.resolvedPath ?? agent.launchCmd}
            value={override}
            onChange={(event) =>
              setLaunchOverride(agent.id, event.target.value)
            }
          />
        </SettingsRow>
      </SettingsGroup>

      {/* ama 的模型密钥只能在界面里填：它不读环境变量，「凭据与密钥」页又在功能开关后面（#898）。 */}
      {agent.id === "ama" ? <AmaKeys /> : null}

      <SettingsGroup title={t("agents.group.install")}>
        <SettingsRow
          label={t("integration.row.cli")}
          {...(agent.installed && agent.resolvedPath
            ? { footnote: agent.resolvedPath }
            : {})}
        >
          <RowValue>{cliValue}</RowValue>
          {cli.available ? (
            <InstallButton install={cli} installed={agent.installed} />
          ) : !agent.installed ? (
            <CopyCommandButton command={agent.launchCmd} />
          ) : null}
        </SettingsRow>
        {acpValue !== null && (
          <SettingsRow label={t("integration.row.acp")}>
            <RowValue>{acpValue}</RowValue>
            {acp && !native && !bundled && (
              <InstallButton install={adapter} installed={acp.installed} />
            )}
          </SettingsRow>
        )}
        {canSignOut(agent) && (
          <SettingsRow label={t("agents.row.account")}>
            <SignOutButton agent={agent} />
          </SettingsRow>
        )}
        <InstallFailure agent={agent} jobs={[cli, adapter]} />
      </SettingsGroup>

      {(hooked || mods !== null || spawn !== null || history !== null) && (
        <SettingsGroup title={t("agents.group.injection")}>
          {hooked && (
            <SettingsRow
              label={t("agents.row.artifacts")}
              {...(!problem && limited ? { footnote: limited } : {})}
            >
              <ValueLoadable loading={!integration} className="h-4 w-16">
                {integration && problem ? (
                  <RowValue>{problem}</RowValue>
                ) : limited ? (
                  <RowValue>{t("integration.state.limited")}</RowValue>
                ) : null}
              </ValueLoadable>
              {legacy.length > 0 && (
                <CleanupButton
                  findings={legacy}
                  busy={busy}
                  onCleanup={() => repair.mutate()}
                />
              )}
              <Button
                variant={problem ? "secondary" : "ghost"}
                size="sm"
                disabled={repair.isPending || !integration}
                loading={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                {t("integration.regenerate")}
              </Button>
            </SettingsRow>
          )}
          {mods !== null && (
            <SettingsRow
              label={t("integration.row.mods")}
              {...(mods.reason ? { footnote: mods.reason } : {})}
            >
              <RowValue>{mods.value}</RowValue>
              {mods.fallback && (
                <Badge variant="outline" size="sm">
                  {t("integration.mods.fallback")}
                </Badge>
              )}
            </SettingsRow>
          )}
          {spawn !== null && (
            <SettingsRow
              label={t("integration.row.canvasAgents")}
              {...(reasons.length > 0
                ? {
                    footnote: reasons
                      .map((reason) => t(`integration.reason.${reason}`))
                      .join(" · "),
                  }
                : {})}
            >
              <RowValue>{t(`integration.canvasAgents.${spawn}`)}</RowValue>
            </SettingsRow>
          )}
          {history !== null && (
            <SettingsRow label={t("integration.row.history")}>
              <RowValue>{history}</RowValue>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}
    </>
  );
}
