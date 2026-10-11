/**
 * 「列出我的仓库」的公共拆解（契约 §29.7）：三个平台的答复先过这里，名字不合格
 * 的行丢掉，克隆地址只认 http(s) 与 ssh / scp 写法，长度有上限。
 *
 * GitHub 与 Gitea 的仓库对象同形（`owner.login`、`clone_url`、`ssh_url`…）；
 * GitLab 的项目另有一套字段（`path_with_namespace`、`http_url_to_repo`…）。
 */

import { validName } from "../github/remote";
import {
  DEFAULT_LIMIT,
  type ForgeKind,
  type ForgeRepository,
  MAX_LIMIT,
  timeMs,
} from "./types";
import { text, webUrl } from "./wire";

/** GitHub `/user/repos` 与 Gitea `/user/repos` 的一行。 */
export interface WireRepository {
  name?: string;
  owner?: { login?: string } | null;
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  default_branch?: string;
  clone_url?: string;
  ssh_url?: string;
  html_url?: string;
  updated_at?: string;
  pushed_at?: string;
}

/** GitLab `/projects` 的一行。 */
export interface WireProject {
  path?: string;
  path_with_namespace?: string;
  description?: string | null;
  visibility?: string;
  forked_from_project?: unknown;
  archived?: boolean;
  default_branch?: string | null;
  http_url_to_repo?: string;
  ssh_url_to_repo?: string;
  web_url?: string;
  last_activity_at?: string;
}

/** 一页的条数：没给或越界用缺省。 */
export function repositoryLimit(limit: number): number {
  return limit > 0 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT;
}

/** ssh 克隆地址：`ssh://…` 或 scp 写法 `user@host:path`；别的丢掉。 */
export function sshUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "";
  if (/[\s\x00-\x1f\x7f]/.test(value)) return "";
  if (/^ssh:\/\/[A-Za-z0-9]\S*$/i.test(value)) return value;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9~/]\S*$/.test(value)
    ? value
    : "";
}

function validOwnerPath(owner: string): boolean {
  return (
    owner !== "" &&
    owner.length <= 255 &&
    owner.split("/").every((segment) => validName(segment))
  );
}

function repository(
  host: string,
  forge: ForgeKind,
  fields: Omit<ForgeRepository, "host" | "forge">,
): ForgeRepository | null {
  if (!validOwnerPath(fields.owner) || !validName(fields.name)) return null;
  // 没有 http(s) 克隆地址的行对挑仓库的人没用：丢掉，而不是给一个空地址。
  if (fields.cloneUrl === "") return null;
  return { host, forge, ...fields };
}

/** GitHub / Gitea 的一行 → 统一形状；不合格答 `null`。 */
export function fromWireRepository(
  host: string,
  forge: ForgeKind,
  value: WireRepository,
): ForgeRepository | null {
  return repository(host, forge, {
    owner: text(value.owner?.login, 255),
    name: text(value.name, 100),
    description: text(value.description, 1024),
    private: value.private === true,
    fork: value.fork === true,
    archived: value.archived === true,
    defaultBranch: text(value.default_branch, 255),
    cloneUrl: webUrl(value.clone_url),
    sshUrl: sshUrl(value.ssh_url),
    webUrl: webUrl(value.html_url),
    updatedAtMs: timeMs(value.pushed_at) ?? timeMs(value.updated_at) ?? 0,
  });
}

/** GitLab 的项目 → 统一形状；owner 是完整的命名空间路径。 */
export function fromWireProject(
  host: string,
  value: WireProject,
): ForgeRepository | null {
  const full = text(value.path_with_namespace, 2048);
  const slash = full.lastIndexOf("/");
  if (slash <= 0) return null;
  return repository(host, "gitlab", {
    owner: full.slice(0, slash),
    name: full.slice(slash + 1),
    description: text(value.description, 1024),
    private: value.visibility !== "public",
    fork: value.forked_from_project != null,
    archived: value.archived === true,
    defaultBranch: text(value.default_branch, 255),
    cloneUrl: webUrl(value.http_url_to_repo),
    sshUrl: sshUrl(value.ssh_url_to_repo),
    webUrl: webUrl(value.web_url),
    updatedAtMs: timeMs(value.last_activity_at) ?? 0,
  });
}

/** 去掉 `null`，保持顺序。 */
export function present(
  rows: readonly (ForgeRepository | null)[],
): ForgeRepository[] {
  return rows.filter((row): row is ForgeRepository => row !== null);
}
