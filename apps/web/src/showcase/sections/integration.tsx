import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useT, usePreferencesStore } from "@/app/preferences-store";
import { ForgeHosted, PullBody, forgeKeys } from "@/panels/github/ForgeHosted";
import {
  ForgeConfigs,
  forgeConfigKeys,
} from "@/panels/settings/pages/ForgeConfigs";
import { adapterInstallKey } from "@/acp/adapter-install";
import { AgentRow } from "@/panels/settings/pages/AgentsPage";
import { AgentDetailPage } from "@/panels/settings/pages/AgentDetailPage";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { MachinesTable } from "@/panels/settings/pages/execution-hosts/MachinesTable";
import { integrationKey } from "@/panels/settings/pages/integration/use-integration";
import { CLI_GROUP, FLEET, idleJob } from "../fixtures/integration";
import {
  FORGE_CONFIGS,
  GITEA_DETECTION,
  GITEA_ISSUES,
  GITEA_PULLS,
  GITLAB_MR,
} from "../fixtures/forge";

const noop = () => undefined;

function Sample({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-[12px] text-muted-foreground">
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * `integration` 分区（设计展示页 §2.1，设计系统 §5.15）：设置页真的 Agent CLI
 * 主表、一家的子页与 SSH 主机表，喂假数据。
 *
 * 主表：正常 · 注入待更新 · 启动器异常 · 安装失败 · CLI 未检测到各一行；集成状态
 * 与安装任务预先放进 query 缓存（永不过期，不去请求 core）。子页：注入待更新、
 * 带两条本产品旧版本残留的那一家。SSH 主机：宽屏表格与窄屏条目。
 *
 * 托管平台（{@link ForgeSamples}）：Gitea 的 issue 列表、GitLab 的 MR 详情与设置页
 * 的配置行。
 */
function useCliCache() {
  const client = useQueryClient();
  // 渲染之前放好：行组件第一次读缓存就拿到，不出现「读取中」也不发请求。
  useState(() => {
    client.setQueryDefaults(["agent-integration"], { staleTime: Infinity });
    client.setQueryDefaults(["acp-adapter-install"], { staleTime: Infinity });
    for (const { agent, integration, jobs } of CLI_GROUP) {
      client.setQueryData(integrationKey(agent.id), integration);
      for (const target of ["cli", "adapter"] as const) {
        client.setQueryData(
          adapterInstallKey(agent.baseAgent ?? agent.id, target),
          jobs?.[target] ?? idleJob(agent.id, target),
        );
      }
    }
    return true;
  });
}

function CliTable() {
  useCliCache();
  return (
    <SettingsGroup>
      {CLI_GROUP.map(({ agent }) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </SettingsGroup>
  );
}

function CliDetail() {
  useCliCache();
  const stale = CLI_GROUP.find(({ integration }) => integration.stale);
  return stale ? (
    <div className="flex flex-col gap-6">
      <AgentDetailPage agent={stale.agent} />
    </div>
  ) : null;
}

/**
 * 托管平台：代码托管面板里 Gitea 的 issue 列表、GitLab 的 MR 详情（只读），与
 * 设置页的按主机 / 仓库配置。数据预先放进 query 缓存（永不过期），不请求 core。
 */
function ForgeSamples() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const client = useQueryClient();
  useState(() => {
    client.setQueryDefaults(["forge"], { staleTime: Infinity, retry: false });
    client.setQueryData(forgeKeys.issues(GITEA_DETECTION.repository, "open"), {
      pages: [{ items: GITEA_ISSUES, nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(forgeKeys.pulls(GITEA_DETECTION.repository, "open"), {
      pages: [{ items: GITEA_PULLS, nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(forgeConfigKeys.all, FORGE_CONFIGS);
    return true;
  });
  return (
    <>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("forge.showcase.gitea")}>
          <div className="rounded-lg border border-border">
            <ForgeHosted detection={GITEA_DETECTION} locale={locale} open />
          </div>
        </Sample>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("forge.showcase.gitlab")}>
          <div className="min-w-0 space-y-3 rounded-lg border border-border p-3">
            <PullBody pull={GITLAB_MR} locale={locale} />
          </div>
        </Sample>
        <Sample caption={t("forge.showcase.settings")}>
          <ForgeConfigs />
        </Sample>
      </div>
    </>
  );
}

export default function IntegrationSection() {
  const t = useT();
  const machines = FLEET.flatMap((host) => (host.ssh ? [host.ssh] : []));
  const table = {
    hosts: machines,
    validating: null,
    onValidate: noop,
    onOpen: noop,
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <Sample caption={t("showcase.integration.cli")}>
          <CliTable />
        </Sample>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("agents.showcase.detail")}>
          <CliDetail />
        </Sample>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("executionHosts.showcase.table")}>
          <MachinesTable {...table} />
        </Sample>
        <Sample caption={t("executionHosts.showcase.compact")}>
          <div className="w-full max-w-[390px]">
            <MachinesTable {...table} compact />
          </div>
        </Sample>
      </div>
      <ForgeSamples />
    </div>
  );
}
