/**
 * 设置搜索的静态索引（设计系统 §5.17）：分区 id → 这一页上 `SettingsRow` 标签的 i18n 键。
 *
 * 顶栏搜索纯客户端：匹配导航项（页名）与这里登记的行标签，结果写成「页名 › 行名」，
 * 回车跳页并高亮那一行。每页至少登记一条，键必须都存在于 i18n（`search-index.test.ts`
 * 拦）；页面增删行标签时，同步改这一张表里自己那一行。
 */
export const SETTINGS_SEARCH: Readonly<Record<string, readonly string[]>> = {
  defaults: [
    "acp.settings.defaultDriver",
    "settings.defaultAgent",
    "settings.defaultPermission",
    "acp.settings.simpleMode",
    "settings.theme",
    "settings.backdrop",
    "settings.translucentWindow",
    "settings.locale",
  ],
  general: [
    "settings.sidebar",
    "settings.splashAnimation",
    "settings.restoreWorkspace",
    "settings.showSystemFiles",
    "settings.showUsage",
    "settings.diagnostics.crashReports",
    "diagnostics.pageErrors",
  ],
  notifications: [
    "settings.notifyNeedsYou",
    "settings.sound",
    "settings.soundVolume",
    "updates.notify",
  ],
  whiteboard: [
    "settings.whiteboard.background",
    "settings.whiteboard.grid",
    "settings.whiteboard.gridSize",
    "settings.whiteboard.snap",
    "settings.whiteboard.wrap",
    "settings.whiteboard.dynamicSize",
    "settings.whiteboard.pasteAtCursor",
    "settings.whiteboard.edgeScroll",
    "settings.whiteboard.focus",
    "settings.whiteboard.animation",
    "settings.whiteboard.inputMode",
    "settings.whiteboard.defaultColor",
    "settings.whiteboard.defaultSize",
  ],
  terminalLook: [
    "terminal.settings.cursor",
    "terminal.settings.cursorBlink",
    "terminal.settings.optionAsMeta",
    "terminal.settings.copyOnSelect",
    "terminal.settings.renderer",
    "terminal.settings.renderBudget",
    "terminal.settings.repaintThrottle",
    "terminal.settings.releaseAfter",
    "terminal.settings.font",
    "terminal.settings.fontStack",
  ],
  browser: [
    "browser.settings.discard",
    "browser.settings.discardMinutes",
    "browser.settings.backgroundMax",
    "browser.settings.startPage",
  ],
  keybindings: [
    "settings.shortcut.enabled",
    "settings.shortcut.profile",
    "settings.shortcut.layer",
    "settings.shortcut.platform",
    "settings.shortcut.reset",
    "settings.shortcut.transfer",
  ],
  agents: ["agents.row.mode", "integration.row.canvasAgents"],
  customAgents: ["settings.customAgent.base", "settings.customAgent.env"],
  sessions: [
    "settings.autoTitle.label",
    "settings.conversations.scope",
    "agents.sessions.indexed",
  ],
  credentials: [
    "settings.copilotAccount",
    "agent.amaKeys.provider",
    "agent.amaKeys.key",
  ],
  usage: [
    "settings.usageEnabled",
    "settings.usageCadence",
    "usage.provider.claude",
    "usage.provider.codex",
    "usage.provider.copilot",
    "settings.codexCliFallback",
    "usage.statusPage",
    "settings.costEnabled",
    "settings.claudeLocalWindow",
    "usage.catalogAutoRefresh",
    "settings.priceSource",
  ],
  workspace: [
    "lsp.formatOnSave",
    "gitRepo.allowExecution",
    "executionHosts.runsOn",
    "settings.workspaceDefaultAgent",
  ],
  service: [
    "host.row.status",
    "host.name",
    "settings.terminalBackend",
    "terminal.settings.dormantAfter",
    "terminal.settings.eco",
    "terminal.settings.ecoIdle",
    "settings.detachedGrace",
    "resources.power.policyLabel",
    "resources.power.whileWorkingLabel",
    "resources.intervalLabel",
    "resources.memory.thresholdLabel",
    "settings.dataDir",
    "settings.dbSize",
    "settings.backup.run",
    "settings.logRetention",
  ],
  machines: [
    "ssh.dialog.add",
    "executionHosts.column.name",
    "executionHosts.column.address",
    "executionHosts.column.worker",
  ],
  forge: [
    "forge.settings.scope",
    "forge.settings.platform",
    "forge.settings.apiBase",
    "forge.settings.token",
    "github.settings.source",
    "github.settings.apiBase",
    "github.settings.token",
  ],
  remoteAccess: [
    "remote.allow",
    "remote.reach",
    "gateway.listen",
    "gateway.port",
    "gateway.publicOrigin",
    "gateway.tls",
    "gateway.tls.acmeEmail",
    "remote.services",
  ],
  devices: ["gateway.pairCode.new", "security.sessions.signOutOthers"],
  security: [
    "security.mfa.enable",
    "security.passkeys.add",
    "security.audit.export",
    "security.oauth.link",
    "security.lockouts.unlock",
  ],
  accounts: [
    "sharing.accountId",
    "sharing.password",
    "sharing.invites.link",
    "sharing.workspace",
    "sharing.groups",
  ],
  about: [
    "settings.licenses",
    "updates.appVersion",
    "updates.hostVersion",
    "updates.hostProtocol",
    "updates.channel",
    "updates.autoCheck",
    "updates.autoDownload",
  ],
};

export interface SettingsSearchHit {
  sectionId: string;
  /** 行标签的 i18n 键；整页命中（页名）时为 `null`。 */
  rowKey: string | null;
}

/** 一次最多列多少条结果。 */
export const SEARCH_LIMIT = 30;

/**
 * 在可见分区里找：页名与行标签（已翻译）包含 `query`（不分大小写）。页名命中排在该页
 * 的行之前；结果按导航顺序、每页内按登记顺序。`query` 为空返回空表。
 */
export function searchSettings(
  query: string,
  sectionIds: readonly string[],
  labelOf: (key: string) => string,
  sectionLabelKey: (id: string) => string,
): SettingsSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const hits: SettingsSearchHit[] = [];
  for (const sectionId of sectionIds) {
    if (
      labelOf(sectionLabelKey(sectionId)).toLocaleLowerCase().includes(needle)
    )
      hits.push({ sectionId, rowKey: null });
    for (const rowKey of SETTINGS_SEARCH[sectionId] ?? []) {
      if (labelOf(rowKey).toLocaleLowerCase().includes(needle))
        hits.push({ sectionId, rowKey });
    }
  }
  return hits.slice(0, SEARCH_LIMIT);
}
