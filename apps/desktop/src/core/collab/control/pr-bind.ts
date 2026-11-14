import type { ForgeKind } from "../../forge/types";
import { forgeService, workspaceRepository } from "../../forge/registry";
import type { ForgeService } from "../../forge/service";
import type { Caller } from "../nodes";
import { Args, Refused } from "../refusals";
import type { CollabContext } from "../service";

/**
 * `report --pr` 与 `items --bind-pr` 的 PR 引用解析（契约 §103.1）。
 *
 * 引用是一个编号（`12`、`#12`）或一个 PR 的网页地址。编号按**工作区的 Git 远端**
 * （选中的主 remote，不一定是 `origin`）认仓库；地址自带仓库。仓库一律交给托管平台域认（`resolve`），
 * 那里有 GitHub / Gitea / GitLab 的识别与多级子组的规矩；认不出平台的拒绝。
 */

export interface ResolvedPull {
  /** `<主机>/<owner>/<名字>`。 */
  readonly repo: string;
  readonly number: number;
  /** 网页地址；平台没给网页根时为空。 */
  readonly url: string;
}

/** 可替换的外部依赖（用例用）：托管平台服务，与工作区主 remote 的地址。 */
export interface PullBindDeps {
  readonly forge: () => ForgeService | undefined;
  readonly originUrl: (
    context: CollabContext,
    workspaceId: string,
  ) => Promise<string | undefined>;
}

/**
 * 工作区的仓库地址：选中的那个 remote（用户选择 → gh-resolved → upstream →
 * origin → 名字排序首个，契约 §111.1），ssh 别名已换成真实主机。读不到
 * （不是本机 Git 仓库、没有 remote、远程执行主机）是 `undefined`。
 */
async function workspaceOrigin(
  _context: CollabContext,
  workspaceId: string,
): Promise<string | undefined> {
  return await workspaceRepository()?.selectedRemoteUrl(workspaceId);
}

export const pullBindDeps: { current: PullBindDeps } = {
  current: { forge: forgeService, originUrl: workspaceOrigin },
};

function bad(message: string): Refused {
  return new Refused(400, "bad_request", message);
}

/** 网页地址里 PR 那一段的写法：GitHub `pull`、Gitea `pulls`、GitLab `merge_requests`。 */
const PULL_MARKERS = ["pull", "pulls", "merge_requests"];

/** `--pr` 的值 → 编号，或（地址）远端地址加编号。 */
export function parsePullRef(
  raw: string,
): { number: number; remoteUrl?: string } | undefined {
  const text = raw.trim();
  const plain = /^#?(\d{1,10})$/.exec(text);
  if (plain !== null) {
    const number = Number.parseInt(plain[1] as string, 10);
    return number > 0 ? { number } : undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const at = segments.findIndex(
    (part, index) =>
      PULL_MARKERS.includes(part) &&
      /^\d{1,10}$/.test(segments[index + 1] ?? ""),
  );
  if (at < 2) return undefined;
  const number = Number.parseInt(segments[at + 1] as string, 10);
  if (number <= 0) return undefined;
  // GitLab 的地址是 `…/<项目>/-/merge_requests/<n>`：去掉 `-`。
  const project = segments.slice(0, at).filter((part) => part !== "-");
  if (project.length < 2) return undefined;
  return {
    number,
    remoteUrl: `${url.protocol}//${url.host}/${project.join("/")}`,
  };
}

/** 平台上 PR 的网页地址。 */
export function pullUrl(
  forge: ForgeKind,
  webUrl: string | null,
  number: number,
): string {
  if (webUrl === null || !/^https?:\/\//i.test(webUrl)) return "";
  const root = webUrl.replace(/\/+$/, "");
  switch (forge) {
    case "gitlab":
      return `${root}/-/merge_requests/${number}`;
    case "gitea":
      return `${root}/pulls/${number}`;
    default:
      return `${root}/pull/${number}`;
  }
}

/** 解析 `--<flag>`；没给是 `undefined`，给了却不合格抛 400。 */
export async function resolvePullFlag(
  context: CollabContext,
  caller: Caller,
  args: Args,
  flag: string,
): Promise<ResolvedPull | undefined> {
  const value = args.value(flag);
  if (value === undefined) return undefined;
  const given = args.text(flag);
  if (value === true || given === undefined) {
    throw bad(`--${flag} 要带 PR 的编号或网页地址。`);
  }
  const parsed = parsePullRef(given);
  if (parsed === undefined) {
    throw bad(
      `--${flag} 是 PR 的编号（12 或 #12）或网页地址（…/pull/12、…/pulls/12、…/-/merge_requests/12）。`,
    );
  }
  const deps = pullBindDeps.current;
  const forge = deps.forge();
  if (forge === undefined) {
    throw new Refused(
      409,
      "forge_unavailable",
      "托管平台域没有装配，不能绑定 PR。",
    );
  }
  const workspaceId = caller.node.workspaceId;
  let remoteUrl = parsed.remoteUrl;
  if (remoteUrl === undefined) {
    remoteUrl = await deps.originUrl(context, workspaceId);
    if (remoteUrl === undefined) {
      throw bad(
        "按编号认不出仓库（工作区不是本机 Git 仓库、没有 remote，或在远程执行主机上）；请改给 PR 的网页地址。",
      );
    }
  }
  let detection;
  try {
    detection = forge.resolve(remoteUrl, workspaceId);
  } catch {
    throw bad("认不出这个 PR 所在的仓库；请给 PR 的网页地址。");
  }
  if (detection.forge === null) {
    throw bad(
      "这个仓库不在已配置的 GitHub / Gitea / GitLab 上，不能绑定 PR；先在设置里配好托管平台。",
    );
  }
  const repo = detection.repository;
  return {
    repo: `${repo.host}/${repo.owner}/${repo.name}`,
    number: parsed.number,
    url: pullUrl(detection.forge, detection.webUrl, parsed.number),
  };
}
