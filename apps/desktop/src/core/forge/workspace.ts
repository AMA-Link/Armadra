/**
 * 工作空间 → 仓库（契约 §111.1）：打开工作空间就认出它对着哪个托管仓库，不要用户
 * 贴远端地址。
 *
 *   1. `git rev-parse --show-toplevel` 确认是 git 仓库，`git remote -v` 取每个
 *      remote 的 fetch 地址（地址里的凭据不进答复）。
 *   2. 主 remote：用户选择 → `remote.<name>.gh-resolved` → upstream → origin →
 *      名字排序首个；用户选择按工作空间存（迁移 0066）。
 *   3. SSH 别名（`git@github-work:o/r`）先问 `ssh -G` 取真实主机。
 *   4. 每个 remote 经 {@link ForgeService.resolve} 识别，不认识的主机先探平台。
 *
 * 远程执行主机上的工作空间：现有执行主机通道没有读 remote 的操作，答
 * `remoteHostUnavailable`，不回退到读控制端磁盘上同名的路径。
 */

import { RepositoryService } from "../git/repository/service";
import { gitService } from "../git";
import { canonicalize } from "../workspaces/roots";
import { getWorkspace } from "../workspaces/table";
import type { DatabaseSync } from "node:sqlite";
import {
  type RemoteEntry,
  type RemoteSelectedBy,
  chooseRemote,
  parseGhResolved,
  parseRemotes,
  stripCredentials,
} from "./remotes";
import { RemoteSelectionStore } from "./selection";
import type { ForgeDetection, ForgeService } from "./service";
import { remoteSegments } from "./service";
import { SshAliasResolver } from "./ssh-alias";
import { forgeError } from "./types";

export type WorkspaceRepositoryReason =
  "ok" | "notGit" | "noRemote" | "remoteHostUnavailable";

export interface WorkspaceRemote {
  readonly name: string;
  /** 已剥掉凭据。 */
  readonly url: string;
  /** 识别失败（地址不是托管仓库的写法）为 `null`。 */
  readonly detection: ForgeDetection | null;
}

/** `POST /api/forge/workspace-repository` 的答复（契约 §111.1）。 */
export interface WorkspaceRepository {
  readonly reason: WorkspaceRepositoryReason;
  readonly selected: string | null;
  readonly selectedBy: RemoteSelectedBy | null;
  readonly remotes: readonly WorkspaceRemote[];
}

/** 在一个目录里跑一条 git（只读）；失败给非零 `status`，不抛。 */
export type GitReader = (
  root: string,
  args: readonly string[],
) => Promise<{ status: number; stdout: string }>;

let fallbackGit: RepositoryService | undefined;

export const realGitReader: GitReader = async (root, args) => {
  const git = gitService() ?? (fallbackGit ??= new RepositoryService());
  try {
    const output = await git.output(root, args, 15_000);
    return {
      status: output.status ?? 1,
      stdout: output.stdout.toString("utf8"),
    };
  } catch {
    return { status: 1, stdout: "" };
  }
};

export interface WorkspaceRepositoryOptions {
  readonly database: DatabaseSync;
  readonly forge: ForgeService;
  readonly git?: GitReader;
  readonly ssh?: SshAliasResolver;
  readonly now?: () => number;
}

/** 一个工作空间最多看这么多个 remote。 */
const MAX_REMOTES = 32;

interface Located {
  readonly workspaceId: string;
  readonly reason: WorkspaceRepositoryReason;
  readonly remotes: readonly RemoteEntry[];
  readonly ghResolved: readonly string[];
}

export class WorkspaceRepositoryService {
  readonly selections: RemoteSelectionStore;
  private readonly git: GitReader;
  private readonly ssh: SshAliasResolver;

  constructor(private readonly options: WorkspaceRepositoryOptions) {
    this.git = options.git ?? realGitReader;
    this.ssh = options.ssh ?? new SshAliasResolver();
    this.selections = new RemoteSelectionStore(options.database, options.now);
  }

  /** 读这个工作空间的 git remote；不识别。 */
  private async locate(workspaceId: string): Promise<Located> {
    let root: string;
    try {
      const workspace = getWorkspace(this.options.database, workspaceId);
      if (workspace.executionHostId !== undefined) {
        return {
          workspaceId,
          reason: "remoteHostUnavailable",
          remotes: [],
          ghResolved: [],
        };
      }
      root = canonicalize(workspace.rootPath);
    } catch (error) {
      if (error instanceof Error && error.name === "DomainError") {
        throw forgeError("notFound", "WORKSPACE");
      }
      // 根目录不在了：不是 git 仓库可言。
      return { workspaceId, reason: "notGit", remotes: [], ghResolved: [] };
    }
    const top = await this.git(root, ["rev-parse", "--show-toplevel"]);
    if (top.status !== 0 || top.stdout.trim() === "") {
      return { workspaceId, reason: "notGit", remotes: [], ghResolved: [] };
    }
    const listed = await this.git(root, ["remote", "-v"]);
    const remotes = parseRemotes(listed.stdout).slice(0, MAX_REMOTES);
    if (listed.status !== 0 || remotes.length === 0) {
      return { workspaceId, reason: "noRemote", remotes: [], ghResolved: [] };
    }
    const resolved = await this.git(root, [
      "config",
      "--get-regexp",
      "^remote\\..*\\.gh-resolved$",
    ]);
    return {
      workspaceId,
      reason: "ok",
      remotes,
      ghResolved: resolved.status === 0 ? parseGhResolved(resolved.stdout) : [],
    };
  }

  /**
   * 一个 remote 地址 → 识别结果：ssh 别名换成真实主机，不认识的主机先探平台，
   * 再交给 {@link ForgeService.resolve}。不认识的写法是 `null`。
   */
  async detect(
    url: string,
    workspaceId: string,
  ): Promise<{ url: string; detection: ForgeDetection | null }> {
    const aliased = stripCredentials(await this.ssh.resolve(url));
    const host = remoteSegments(aliased)?.host;
    if (host !== undefined) await this.options.forge.warm(host, workspaceId);
    try {
      return {
        url: aliased,
        detection: this.options.forge.resolve(aliased, workspaceId),
      };
    } catch {
      return { url: aliased, detection: null };
    }
  }

  async repository(workspaceId: string): Promise<WorkspaceRepository> {
    const located = await this.locate(workspaceId);
    if (located.reason !== "ok") {
      return {
        reason: located.reason,
        selected: null,
        selectedBy: null,
        remotes: [],
      };
    }
    const chosen = chooseRemote(located.remotes, {
      user: this.selections.get(workspaceId),
      ghResolved: located.ghResolved,
    });
    const remotes = await Promise.all(
      located.remotes.map(async (remote): Promise<WorkspaceRemote> => {
        const seen = await this.detect(remote.url, workspaceId);
        return {
          name: remote.name,
          url: stripCredentials(remote.url),
          detection: seen.detection,
        };
      }),
    );
    return {
      reason: "ok",
      selected: chosen?.name ?? null,
      selectedBy: chosen?.by ?? null,
      remotes,
    };
  }

  /** 用户在面板里切主 remote；`null` 回到默认顺序。 */
  async select(
    workspaceId: string,
    remote: string | null,
  ): Promise<WorkspaceRepository> {
    const located = await this.locate(workspaceId);
    if (remote !== null) {
      if (!located.remotes.some((entry) => entry.name === remote)) {
        throw forgeError("invalid", "REMOTE_UNKNOWN");
      }
    }
    this.selections.set(workspaceId, remote);
    return await this.repository(workspaceId);
  }

  /**
   * 选中的 remote 的地址（已换掉 ssh 别名、剥掉凭据，主机已探过），给 PR 绑定用。
   * 读不到（不是 git、没有 remote、远程主机）是 `undefined`。
   */
  async selectedRemoteUrl(workspaceId: string): Promise<string | undefined> {
    let located: Located;
    try {
      located = await this.locate(workspaceId);
    } catch {
      return undefined;
    }
    if (located.reason !== "ok") return undefined;
    const chosen = chooseRemote(located.remotes, {
      user: this.selections.get(workspaceId),
      ghResolved: located.ghResolved,
    });
    const remote = located.remotes.find((entry) => entry.name === chosen?.name);
    if (remote === undefined) return undefined;
    return (await this.detect(remote.url, workspaceId)).url;
  }
}
