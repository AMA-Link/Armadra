import { statSync } from "node:fs";
import { join } from "node:path";

import { codeOf } from "../github/errors";
import { DomainError } from "../workspaces/support";
import { validateCloneUrl } from "./clone";

/**
 * 新建工作空间对话框要的两样东西（契约 §65）：克隆落在哪个目录的缺省值，以及
 * 已连接的 GitHub 账号能克隆的仓库。
 *
 * 仓库列表只读这台 core 已经配好的 GitHub 凭据（`gh` 登录或钥匙串里的令牌），
 * 令牌不经过这里、也不出现在答案里；克隆本身仍走用户自己的 git 凭据设置。
 */

/** 家目录下按这个顺序找第一个存在的目录，都没有就用家目录本身。 */
const PARENT_CANDIDATES = ["Projects", "projects", "Developer", "code", "src"];

/** 列表一页就够选：按最近更新排，最多这么多条。 */
const MAX_REPOSITORIES = 100;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 克隆的缺省父目录：`~/Projects` 这类常见目录，没有就是 `~`。 */
export function defaultCloneParent(home: string | undefined): {
  parent: string;
} {
  if (home === undefined) return { parent: "" };
  for (const name of PARENT_CANDIDATES) {
    const candidate = join(home, name);
    if (isDirectory(candidate)) return { parent: candidate };
  }
  return { parent: home };
}

export interface CloneRepository {
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly private: boolean;
  readonly updatedAt: string;
}

export interface CloneRepositories {
  /** 这台 core 有一份能用的 GitHub 凭据。 */
  readonly connected: boolean;
  readonly account: string | null;
  readonly repositories: CloneRepository[];
}

/** {@link listCloneRepositories} 用到的那一小块 GitHub 凭据服务。 */
export interface RepositoryAccount {
  status(): Promise<{ available: boolean; accountLogin: string }>;
  apiClient(): {
    get(
      path: string,
      query?: Record<string, string>,
    ): Promise<{ status: number; body: Buffer }>;
  };
  noteFailure(error: unknown): void;
  noteSuccess(): void;
}

function upstreamFailure(error: unknown): DomainError {
  const code = codeOf(error);
  if (code === "UNAUTHENTICATED" || code === "PERMISSION_DENIED") {
    return new DomainError(
      502,
      "forge_credential_rejected",
      "GitHub rejected the configured credential",
    );
  }
  return new DomainError(502, "forge_unavailable", "GitHub is unavailable");
}

/** GitHub `/user/repos` 的一条 → 答案里的一条；地址不在克隆名单里的丢掉。 */
function repositoryOf(raw: unknown): CloneRepository | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const fullName = record.full_name;
  const cloneUrl = record.clone_url;
  if (typeof fullName !== "string" || typeof cloneUrl !== "string") {
    return undefined;
  }
  try {
    validateCloneUrl(cloneUrl);
  } catch {
    return undefined;
  }
  const updated = record.pushed_at ?? record.updated_at;
  return {
    fullName,
    cloneUrl,
    private: record.private === true,
    updatedAt: typeof updated === "string" ? updated : "",
  };
}

/**
 * 已连接账号能克隆的仓库：自己的、协作的、所在组织的，按最近更新排。
 *
 * 没有配凭据或凭据此刻取不出来不是错误，答 `connected: false` 与空列表，页面
 * 据此显示「未连接」；GitHub 拒绝或连不上才是错误。
 */
export async function listCloneRepositories(
  account: RepositoryAccount | undefined,
): Promise<CloneRepositories> {
  const disconnected = { connected: false, account: null, repositories: [] };
  if (account === undefined) return disconnected;
  const status = await account.status();
  if (!status.available) return disconnected;
  let body: unknown;
  try {
    const response = await account.apiClient().get("/user/repos", {
      per_page: String(MAX_REPOSITORIES),
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    body = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    account.noteFailure(error);
    throw upstreamFailure(error);
  }
  if (!Array.isArray(body)) {
    throw new DomainError(502, "forge_unavailable", "GitHub is unavailable");
  }
  account.noteSuccess();
  const repositories = body
    .map(repositoryOf)
    .filter((entry): entry is CloneRepository => entry !== undefined)
    .slice(0, MAX_REPOSITORIES);
  return {
    connected: true,
    account: status.accountLogin === "" ? null : status.accountLogin,
    repositories,
  };
}
