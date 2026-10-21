/**
 * ACP 域的用例装配（只给测试用）：真数据库、真路由、真终端管理器，ACP Agent
 * 是 `@armadra/agent/acp` 的假 Agent（真子进程），注册成一个基础 CLI 为
 * OpenCode 的 `custom:` 条目——OpenCode 自己就是 ACP 入口，条目的启动程序
 * 顶替表里的程序（`adapters.ts::adapterFor`）。
 */

import { randomUUID } from "node:crypto";

import { fakeAcpAgentPath } from "@armadra/agent/acp";

import { install as installAgents, setTerminalBridge } from "../agent";
import { setAcpApprovalAnswerer } from "../agent/approvals";
import { install as installCanvas } from "../canvas/routes";
import type { CoreContext } from "../main";
import type { SecretBackend } from "../secrets/backend";
import { install as installSettings } from "../settings";
import { install as installTerminals } from "../terminal/install";
import type { TerminalDomain } from "../terminal/install";
import { fixture, type Fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import {
  type TimelineDomain,
  install as installTimeline,
  timelineDomainOf,
} from "../timeline";
import { entriesFromTimeline } from "../history/acp-mirror";
import type { TranscriptEntry } from "../history/types";
import { install as installAcp, provideAcpTerminal } from ".";

export const FAKE_AGENT = "custom:fake-acp";

export interface AcpCore {
  readonly core: Fixture;
  readonly terminal: TerminalDomain;
  readonly workspaceId: string;
  readonly boardId: string;
  /** 在板上放一个以 ACP 驱动的终端节点，答节点 id。 */
  node(options?: {
    driver?: "acp" | "terminal";
    agentId?: string;
    title?: string;
    /** 节点绑定的凭据条目名（`agent.account.credentialRef`，契约 §20.3）。 */
    credentialRef?: string;
    /** SSH 节点：`data.ssh.hostId`（契约 §26 的 SSH 小节）。 */
    sshHostId?: string;
  }): Promise<string>;
  /** 连一条边（`link`）。 */
  link(source: string, target: string): Promise<void>;
  stop(): Promise<void>;
}

/** 轮询直到成立（机器快慢不一，不睡固定时长）。 */
export async function until<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  seconds = 10,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `condition never held; last value ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export async function acpCore(
  options: {
    minimal?: boolean;
    /** 假 Agent 开会话答模型配置项（契约 §26.2 的用例：`--config-options`）。 */
    configOptions?: boolean;
    /** 换掉假 Agent 的脚本（缺省 `@armadra/agent/acp` 的那个）。 */
    script?: string;
    /** 自定义条目的基础 CLI；缺省 `opencode`。 */
    baseAgent?: string;
    /** 节点凭据用的密钥后端（缺省按数据目录解析）。 */
    credentialSecrets?: SecretBackend;
  } = {},
): Promise<AcpCore> {
  let terminal: TerminalDomain | undefined;
  const core = fixture([
    installWorkspaces,
    installCanvas,
    installSettings,
    installAgents,
    (context: CoreContext) => {
      terminal = installTerminals(context, {
        configured: "direct",
        ...(options.credentialSecrets === undefined
          ? {}
          : {
              credentialSecrets: options.credentialSecrets,
              platform: "darwin",
            }),
      });
    },
    installAcp,
  ]);
  const settings = await core.call("PATCH", "/api/settings", {
    agents: {
      custom: [
        {
          id: FAKE_AGENT,
          label: "Fake ACP",
          launchCmd: process.execPath,
          args: [
            options.script ?? fakeAcpAgentPath(),
            ...(options.minimal ? ["--minimal"] : []),
            ...(options.configOptions ? ["--config-options"] : []),
          ],
          baseAgent: options.baseAgent ?? "opencode",
        },
      ],
    },
  });
  if (settings.status !== 200) {
    throw new Error(`settings: ${JSON.stringify(settings.body)}`);
  }
  const workspaces = (await core.call("GET", "/api/workspaces")).body as {
    id: string;
  }[];
  const workspaceId = (workspaces[0] as { id: string }).id;
  const boards = (
    await core.call("GET", `/api/workspaces/${workspaceId}/boards`)
  ).body as { id: string }[];
  const boardId = (boards[0] as { id: string }).id;
  const documentPath = `/api/workspaces/${workspaceId}/boards/${boardId}/document`;

  const mutate = async (
    change: (document: {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    }) => void,
  ) => {
    const current = (await core.call("GET", documentPath)).body as {
      board: { updatedAt: string };
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
      viewport: unknown;
      whiteboard: unknown;
    };
    const next = {
      nodes: [...current.nodes],
      edges: [...current.edges],
    };
    change(next);
    const saved = await core.call("PUT", documentPath, {
      expectedUpdatedAt: current.board.updatedAt,
      nodes: next.nodes,
      edges: next.edges,
      viewport: current.viewport ?? { x: 0, y: 0, zoom: 1 },
      whiteboard: current.whiteboard ?? "",
    });
    if (saved.status !== 200) {
      throw new Error(`save: ${JSON.stringify(saved.body)}`);
    }
  };

  return {
    core,
    terminal: terminal as TerminalDomain,
    workspaceId,
    boardId,
    async node(input = {}) {
      const id = randomUUID();
      const stamp = new Date().toISOString();
      await mutate((document) => {
        document.nodes.push({
          id,
          boardId,
          type: "terminal",
          title: input.title ?? "Agent",
          color: "#0a84ff",
          position: { x: 100 * document.nodes.length, y: 100 },
          size: { width: 480, height: 320 },
          labels: [],
          note: "",
          data: {
            kind: "terminal",
            cwd: core.directory,
            ...(input.sshHostId === undefined
              ? {}
              : { ssh: { hostId: input.sshHostId } }),
            agent: {
              id: input.agentId ?? FAKE_AGENT,
              driver: input.driver ?? "acp",
              ...(input.credentialRef === undefined
                ? {}
                : {
                    account: {
                      accountId: "default",
                      credentialRef: input.credentialRef,
                    },
                  }),
            },
          },
          createdAt: stamp,
          updatedAt: stamp,
        });
      });
      return id;
    },
    async link(source, target) {
      const stamp = new Date().toISOString();
      await mutate((document) => {
        document.edges.push({
          id: randomUUID(),
          boardId,
          source,
          target,
          kind: "link",
          createdAt: stamp,
          updatedAt: stamp,
        });
      });
    },
    async stop() {
      await terminal?.stop();
      // 直连 PTY 的退出通知在 `stop` 之后才到：等它落库再关库。
      await new Promise((resolve) => setTimeout(resolve, 150));
      provideAcpTerminal(undefined);
      setAcpApprovalAnswerer(undefined);
      setTerminalBridge(undefined);
      core.close();
    },
  };
}

/**
 * 这台 core 的时间线域；还没装就装上。要在起会话**之前**调用：会话内容只写时间线
 * （B10），没有时间线域的 core 里会话读不到任何内容。
 */
export function ensureTimeline(open: AcpCore): TimelineDomain {
  return (timelineDomainOf(open.core.server) ??
    installTimeline(open.core)) as TimelineDomain;
}

/** 一条会话的时间线条目（先把写入器攒着的刷出去）。 */
export function timelineItemsOf(open: AcpCore, rowId: string) {
  const domain = ensureTimeline(open);
  domain.writer.flush();
  return domain.store.allItems(rowId);
}

/** 一条会话的对话记录（用户 / 助手文本、工具调用与结果），旧 `…/log` 的 `entries` 的替身。 */
export function transcriptOf(open: AcpCore, rowId: string): TranscriptEntry[] {
  return entriesFromTimeline(timelineItemsOf(open, rowId));
}
