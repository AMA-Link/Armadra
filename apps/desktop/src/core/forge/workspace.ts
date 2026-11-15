/**
 * 工作空间 → 仓库（契约 §111.1）：打开工作空间就认出它对着哪个托管仓库，不要用户
 * 贴远端地址。
 *
 *   1. `git rev-parse --show-toplevel` 确认是 git 仓库，`git remote -v` 取每个
 *      remote 的 fetch 地址（地址里的凭据不进答复）。
 *   2. 主 remote：用户选择 → `remote.<name>.gh-resolved` → upstream → origin →
 *      名字排序首个；用户选择按工作空间存（迁移 0066）。
 *   3. SSH 别名（`git@github-work:o/r`）先问 `ssh -G` 取真实主机。
 *   4. 每个 remote 经 {@link ForgeService.resolve} 识别，不认识的主机先探平台；
 *      所有 remote 并行预热、整体限时（{@link WARM_DEADLINE_MS}），不可达的主机
 *      先按未知给出，不拖住其余结果。
 *
 * 远程执行主机上的工作空间：经执行主机通道的 `git.remotes` 读 remote（地址在
 * 远端已脱敏，这里再剥一次凭据），识别、令牌与托管 API 请求仍在控制端。第一版
 * 不读 `gh-resolved`，SSH 别名不在控制端跑 `ssh -G`（那是远端的 ssh 配置），按
 * 地址原样识别。主机断线、没装配远端执行或 Worker 不支持这个操作时答
 * `remoteHostUnavailable`，不回退到读控制端磁盘上同名的路径。
 */

import { RepositoryService } from "../git/repository/service";
import { gitService } from "../git";
import { executeOn, type ExecutionTarget } from "../remote/execute";
import { CoreFailure } from "../http/errors";
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
import { WARM_DEADLINE_MS, settleWithin } from "./deadline";
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

/**
 * 在执行主机上读一个工作空间的 remote（`git.remotes`）。答复是
 * `{ name, fetchUrl, pushUrl, redacted }[]`；连不上、不支持时抛。
 */
export type RemoteHostReader = (target: ExecutionTarget) => Promise<unknown>;

export const realRemoteHostReader: RemoteHostReader = async (target) =>
  await executeOn(target, "git.remotes", { path: "." });

export interface WorkspaceRepositoryOptions {
  readonly database: DatabaseSync;
  readonly forge: ForgeService;
  readonly git?: GitReader;
  readonly remoteHost?: RemoteHostReader;
  readonly ssh?: SshAliasResolver;
  readonly now?: () => number;
  /**
   * 时限（毫秒），缺省 {@link WARM_DEADLINE_MS}：读远程执行主机上的 remote 最多
   * 等这么久，一次读取里所有 remote 的预热加起来也最多等这么久。
   */
  readonly warmDeadlineMs?: number;
}

/** 一个工作空间最多看这么多个 remote。 */
const MAX_REMOTES = 32;

interface Located {
  readonly workspaceId: string;
  readonly reason: WorkspaceRepositoryReason;
  readonly remotes: readonly RemoteEntry[];
  readonly ghResolved: readonly string[];
  /** 在远程执行主机上：地址里的 SSH 别名属于远端的 ssh 配置，不在本机解析。 */
  readonly remoteHost: boolean;
}

/** `git.remotes` 的答复 → remote 列表（只取 fetch 地址，名字排序、最多 32 个）。 */
function remoteEntries(value: unknown): RemoteEntry[] {
  if (!Array.isArray(value)) return [];
  const found = new Map<string, string>();
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { name, fetchUrl } = item as { name?: unknown; fetchUrl?: unknown };
    if (typeof name !== "string" || typeof fetchUrl !== "string") continue;
    if (name === "" || fetchUrl === "" || found.has(name)) continue;
    found.set(name, stripCredentials(dropRedactedUser(fetchUrl)));
  }
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_REMOTES)
    .map(([name, url]) => ({ name, url }));
}

/**
 * 远端脱敏把 `<scheme>://<userinfo>@` 一律换成 `<scheme>://[redacted]@`，连
 * `ssh://git@…` 里的用户名也换掉；那一段对识别与展示都没有用，整段去掉。
 */
function dropRedactedUser(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)\[redacted\]@/, "$1");
}

/** Worker 对「根目录不是 git 仓库 / 不是目录」的答复（`RepositoryService.context`）。 */
const NOT_GIT_MESSAGE =
  /not a (?:working )?git (?:working )?repository|git path must be a directory/i;

/**
 * 远端答的错误：只有 400「不是 git 仓库、不是目录」是工作空间本身的问题；其余
 * （409 重连窗口里的 `instance_mismatch`、403 授权根外、remote 过多的 400、501
 * 不支持、503 断线、没装配远端执行、超时）都按主机这条路走不通。
 */
function remoteFailureReason(error: unknown): WorkspaceRepositoryReason {
  if (
    error instanceof CoreFailure &&
    error.status === 400 &&
    NOT_GIT_MESSAGE.test(error.message)
  ) {
    return "notGit";
  }
  return "remoteHostUnavailable";
}

/** 等远端答复的时限内没答，按主机这条路走不通。 */
class RemoteHostTimeout extends Error {}

function empty(
  workspaceId: string,
  reason: WorkspaceRepositoryReason,
  remoteHost: boolean,
): Located {
  return { workspaceId, reason, remotes: [], ghResolved: [], remoteHost };
}

export class WorkspaceRepositoryService {
  readonly selections: RemoteSelectionStore;
  private readonly git: GitReader;
  private readonly remoteHost: RemoteHostReader;
  private readonly ssh: SshAliasResolver;

  constructor(private readonly options: WorkspaceRepositoryOptions) {
    this.git = options.git ?? realGitReader;
    this.remoteHost = options.remoteHost ?? realRemoteHostReader;
    this.ssh = options.ssh ?? new SshAliasResolver();
    this.selections = new RemoteSelectionStore(options.database, options.now);
  }

  /** 读这个工作空间的 git remote；不识别。 */
  private async locate(workspaceId: string): Promise<Located> {
    let root: string;
    try {
      const workspace = getWorkspace(this.options.database, workspaceId);
      if ((workspace.executionHostId ?? "") !== "") {
        return await this.locateRemote(workspaceId, {
          rootPath: workspace.rootPath,
          executionHostId: workspace.executionHostId,
        });
      }
      root = canonicalize(workspace.rootPath);
    } catch (error) {
      if (error instanceof Error && error.name === "DomainError") {
        throw forgeError("notFound", "WORKSPACE");
      }
      // 根目录不在了：不是 git 仓库可言。
      return empty(workspaceId, "notGit", false);
    }
    const top = await this.git(root, ["rev-parse", "--show-toplevel"]);
    if (top.status !== 0 || top.stdout.trim() === "") {
      return empty(workspaceId, "notGit", false);
    }
    const listed = await this.git(root, ["remote", "-v"]);
    const remotes = parseRemotes(listed.stdout).slice(0, MAX_REMOTES);
    if (listed.status !== 0 || remotes.length === 0) {
      return empty(workspaceId, "noRemote", false);
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
      remoteHost: false,
    };
  }

  /** 远程执行主机上的工作空间：经执行主机通道读 remote；不读 `gh-resolved`。 */
  private async locateRemote(
    workspaceId: string,
    target: ExecutionTarget,
  ): Promise<Located> {
    let answer: unknown;
    try {
      // 执行主机的握手最长 30 秒、单个请求最长 60 秒；面板与 `report --pr` 不跟着
      // 等。超时后请求在后台跑完，结果丢掉。
      const pending = this.remoteHost(target);
      pending.catch(() => undefined);
      const done = await settleWithin(
        pending,
        this.options.warmDeadlineMs ?? WARM_DEADLINE_MS,
      );
      if (!done) throw new RemoteHostTimeout();
      answer = await pending;
    } catch (error) {
      return empty(workspaceId, remoteFailureReason(error), true);
    }
    const remotes = remoteEntries(answer);
    if (remotes.length === 0) return empty(workspaceId, "noRemote", true);
    return {
      workspaceId,
      reason: "ok",
      remotes,
      ghResolved: [],
      remoteHost: true,
    };
  }

  /**
   * 一个 remote 地址 → 识别结果：ssh 别名换成真实主机，不认识的主机先探平台，
   * 再交给 {@link ForgeService.resolve}。不认识的写法是 `null`。
   *
   * `remoteHost` 为真时地址来自远程执行主机：不在本机跑 `ssh -G`，别名按原样
   * 识别（认不出就是未知主机）。预热超过 `deadlineMs` 不再等，按此刻缓存里有的
   * 识别；探测在后台跑完，下一次读取就用得上。
   */
  async detect(
    url: string,
    workspaceId: string,
    remoteHost = false,
    deadlineMs = this.options.warmDeadlineMs ?? WARM_DEADLINE_MS,
  ): Promise<{ url: string; detection: ForgeDetection | null }> {
    const aliased = stripCredentials(
      remoteHost ? url : await this.ssh.resolve(url),
    );
    const forge = this.options.forge;
    let ready: ForgeDetection | null = null;
    const warmed = await settleWithin(
      forge.resolveReady(aliased, workspaceId).then(
        (detection) => {
          ready = detection;
        },
        () => undefined,
      ),
      deadlineMs,
    );
    if (warmed) return { url: aliased, detection: ready };
    try {
      return { url: aliased, detection: forge.resolve(aliased, workspaceId) };
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
    // 所有 remote 共用一个截止时刻：并行预热，整体最多等一个时限。
    const deadline =
      Date.now() + (this.options.warmDeadlineMs ?? WARM_DEADLINE_MS);
    const remotes = await Promise.all(
      located.remotes.map(async (remote): Promise<WorkspaceRemote> => {
        const seen = await this.detect(
          remote.url,
          workspaceId,
          located.remoteHost,
          Math.max(0, deadline - Date.now()),
        );
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
   * 读不到（不是 git、没有 remote、远程主机连不上）是 `undefined`。
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
    return (await this.detect(remote.url, workspaceId, located.remoteHost)).url;
  }
}
