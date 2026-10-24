/**
 * 挂载 Armadra 云（SaaS）上的主机时记的归属与团队（契约 §86）。
 *
 * 团队只从接收方自己的云得出：断言里的 `team.teamId`（接收方自己向签发它的云换来的，
 * 这里只读不验——验签是主机的事，这里的值只作分组展示），团队名只取签发这份断言的那个
 * 云的 `me.spaces`。对端 core 在 `cloud/login` 里报的任何团队都不采信。
 */

import type { RemoteClient, RemoteEndpoint } from "./remote-client";
import type { RemoteRow, SourcesStore } from "./store";

export interface SaasMountInfo {
  /** 不是我自己的主机（`me.sources` 的 `owner` 为假）：记 `shared`；目录取不到是 `undefined`（不判）。 */
  readonly shared: boolean | undefined;
  readonly teamId: string;
  readonly teamName: string;
  /** 能据以写团队的值；归属没判出来（目录取不到）时没有，调用方不动原有的团队。 */
  readonly team: { teamId: string; teamName: string } | undefined;
}

/** 断言（JWS）载荷里的 `team.teamId`；`aud` 不是这台源或认不出是空串。 */
export function assertionTeamId(assertion: string, sourceId: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { aud?: unknown; team?: { teamId?: unknown } };
    if (payload.aud !== sourceId) return "";
    const teamId = payload.team?.teamId;
    return typeof teamId === "string" ? teamId.trim().slice(0, 128) : "";
  } catch {
    return "";
  }
}

/** 查这台主机在这个云里是不是别人的、属于哪个团队；名字取不到留空，不拦挂载。非 SaaS 云答 `undefined`。 */
export async function saasMountInfo(
  client: RemoteClient,
  remote: RemoteRow,
  token: { accessToken: string } | undefined,
  signed: { assertion: string },
  at: { endpoint: RemoteEndpoint; sourceId: string },
): Promise<SaasMountInfo | undefined> {
  if (remote.kind !== "saas" || token === undefined) return undefined;
  const { endpoint, sourceId } = at;
  const { accessToken } = token;
  const listed = await client
    .sources(endpoint, accessToken)
    .catch(() => undefined);
  const entry = listed?.find((one) => one.sourceId === sourceId);
  // 目录取不到、或目录里没有这台：不知道是不是别人的，不判（调用方沿用原归属与团队）。
  const shared = entry === undefined ? undefined : entry.owner !== true;
  const teamId =
    shared === false ? "" : assertionTeamId(signed.assertion, sourceId);
  let teamName = "";
  if (teamId !== "") {
    const spaces = await client.spaces(endpoint, accessToken).catch(() => []);
    for (const space of spaces) {
      if (space.kind === "team" && space.teamId === teamId) {
        teamName = space.name;
      }
    }
  }
  return {
    shared,
    teamId,
    teamName,
    team: shared === undefined ? undefined : { teamId, teamName },
  };
}

/** 中继重新登录后按自己的云刷新团队（被移出团队、主机换了团队）；只改别人分享的行。 */
export async function refreshMountedTeam(
  client: RemoteClient,
  store: SourcesStore,
  remote: RemoteRow,
  token: { accessToken: string } | undefined,
  signed: { assertion: string },
  at: { endpoint: RemoteEndpoint; sourceId: string },
): Promise<void> {
  const info = await saasMountInfo(client, remote, token, signed, at);
  if (info?.shared === true && info.team !== undefined)
    store.setTeam(at.sourceId, info.team);
}
