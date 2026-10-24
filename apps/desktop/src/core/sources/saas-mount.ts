/**
 * 挂载 Armadra 云（SaaS）上的主机时记的归属与团队（契约 §86）。
 *
 * 团队只从接收方自己的云得出：断言里的 `team.teamId`（接收方自己向签发它的云换来的，
 * 这里只读不验——验签是主机的事，这里的值只作分组展示），团队名只取签发这份断言的那个
 * 云的 `me.spaces`。对端 core 在 `cloud/login` 里报的任何团队都不采信。
 */

import type { RemoteClient, RemoteEndpoint } from "./remote-client";
import type { RemoteRow } from "./store";

export interface SaasMountInfo {
  /** 不是我自己的主机（`me.sources` 的 `owner` 为假）：记 `shared`。 */
  readonly shared: boolean;
  readonly teamId: string;
  readonly teamName: string;
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
  const listed = await client.sources(endpoint, accessToken).catch(() => []);
  const mine = listed.find((one) => one.sourceId === sourceId)?.owner === true;
  const teamId = mine ? "" : assertionTeamId(signed.assertion, sourceId);
  let teamName = "";
  if (teamId !== "") {
    const spaces = await client.spaces(endpoint, accessToken).catch(() => []);
    for (const space of spaces) {
      if (space.kind === "team" && space.teamId === teamId) {
        teamName = space.name;
      }
    }
  }
  return { shared: !mine, teamId, teamName };
}
