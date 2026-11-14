/**
 * 工作空间的 git 远端：读、挑主 remote、剥凭据（契约 §111）。
 *
 * 这里只有纯函数；跑 git 的在 `workspace.ts`。
 */

export interface RemoteEntry {
  readonly name: string;
  /** 原始 fetch 地址，可能带凭据：只在 core 内部用，进答复前过 {@link stripCredentials}。 */
  readonly url: string;
}

export type RemoteSelectedBy =
  "user" | "ghResolved" | "upstream" | "origin" | "first";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** `git remote -v` 的输出 → 每个 remote 的 fetch 地址，按名字排序。 */
export function parseRemotes(output: string): RemoteEntry[] {
  const found = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S.*?)\s+\(fetch\)\s*$/.exec(line.trim());
    if (match === null) continue;
    const name = match[1] as string;
    if (!NAME.test(name) || found.has(name)) continue;
    found.set(name, match[2] as string);
  }
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, url]) => ({ name, url }));
}

/**
 * `git config --get-regexp '^remote\..*\.gh-resolved$'` 的输出 → 带有非空
 * `gh-resolved` 的 remote 名（那是用户用 `gh repo set-default` 选过的）。
 */
export function parseGhResolved(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^remote\.(.+)\.gh-resolved\s+(\S.*)$/i.exec(line.trim());
    if (match !== null) names.push(match[1] as string);
  }
  return names;
}

/**
 * 主 remote：用户选择 → `gh-resolved` → `upstream` → `origin` → 名字排序首个。
 * 用户选的名字已经不存在时当作没选。
 */
export function chooseRemote(
  remotes: readonly RemoteEntry[],
  options: { user?: string | null; ghResolved?: readonly string[] },
): { name: string; by: RemoteSelectedBy } | null {
  const has = (name: string) => remotes.some((remote) => remote.name === name);
  if (options.user !== undefined && options.user !== null) {
    if (has(options.user)) return { name: options.user, by: "user" };
  }
  const resolved = (options.ghResolved ?? []).filter(has).sort();
  if (resolved[0] !== undefined) return { name: resolved[0], by: "ghResolved" };
  if (has("upstream")) return { name: "upstream", by: "upstream" };
  if (has("origin")) return { name: "origin", by: "origin" };
  const first = [...remotes].sort((a, b) => (a.name < b.name ? -1 : 1))[0];
  return first === undefined ? null : { name: first.name, by: "first" };
}

/**
 * 地址里的凭据不进答复：http(s) 去掉整段 userinfo（令牌常放在用户名位置），
 * 其余协议只去掉密码（`ssh://git@host` 的用户名不是秘密）。scp 写法 `git@host:p`
 * 没有密码这一说，原样。
 */
export function stripCredentials(url: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)@(.*)$/s.exec(url);
  if (match === null) return url;
  const scheme = match[1] as string;
  const userinfo = match[2] as string;
  const rest = match[3] as string;
  if (/^https?:\/\/$/i.test(scheme)) return `${scheme}${rest}`;
  const colon = userinfo.indexOf(":");
  const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
  return user === "" ? `${scheme}${rest}` : `${scheme}${user}@${rest}`;
}
