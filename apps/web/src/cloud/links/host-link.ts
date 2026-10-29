import { coded, refusalCode, type HostChannel } from "../host-channel";

/**
 * 控制台「新建链接」（设计 saas-host-open §4.3，B5；core 契约 §33.9、§88.4）：经背书器同一个通道池，
 * 以本浏览器受信设备的主人会话调主机 core 的 `sources.shareLinkCreate`。主机用它自己存着的
 * 设备码会话调云端 `links.create`、签本机邀请，整条链接存进主机的 SecretStore——所以链接也出现在
 * 主机的分享弹层里。控制台不在云端另开捷径，权限由主机判（`settings:write`）。
 *
 * 整条链接（含秘密与邀请令牌）只作为返回值交给结果对话框：不进地址、日志、查询缓存。
 */

export const LINK_ROLES = ["viewer", "editor", "operator"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export interface NewHostLink {
  readonly role: LinkRole;
  readonly ttlMs: number;
  readonly maxUses: number;
  readonly label: string;
}

interface RemoteRow {
  readonly serviceId?: unknown;
  readonly kind?: unknown;
  readonly issuer?: unknown;
  readonly guest?: unknown;
  readonly registered?: unknown;
}

const originOf = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
};

/**
 * 主机源表里签发方是这个控制台的 SaaS 远程服务（不是访客行）；登记着的优先。没有答 `undefined`。
 */
export function consoleRemote(
  remotes: readonly RemoteRow[],
  issuer: string,
): string | undefined {
  const origin = originOf(issuer);
  const rows = remotes.filter(
    (row) =>
      row.kind === "saas" &&
      row.guest !== true &&
      typeof row.serviceId === "string" &&
      row.serviceId !== "" &&
      typeof row.issuer === "string" &&
      origin !== "" &&
      originOf(row.issuer) === origin,
  );
  const pick = rows.find((row) => row.registered === true) ?? rows[0];
  return pick?.serviceId as string | undefined;
}

/**
 * 建一条整台主机的分享链接，答整条链接。失败抛带 `code` 的错：
 * `device_untrusted`（本浏览器不是这台主机的受信设备）、`cloud_not_registered`（主机没有
 * 这个控制台的 SaaS 登录行）、主机原样答的码（`forbidden`、`source_unauthorized`、
 * `team_policy_denied`……）、主机限流登录 `rate_limited`（带 `retryAfterMs`）、通道问题
 * `e2e_device_unavailable`。
 */
export async function createHostLink(
  channel: HostChannel,
  issuer: string,
  sourceId: string,
  input: NewHostLink,
): Promise<string> {
  // 不先另 probe：通道池没有会话时自己先 probe，不受信抛 `device_untrusted`、不登录（不在主机上挂待确认）；
  // 有会话就直接用。多一次 probe 只会白扣主机每账号每分钟 5 次的登录额度。
  const listed = await channel.request(sourceId, "/api/sources", {
    method: "GET",
  });
  if (!listed.ok) throw coded(await refusalCode(listed));
  const table = (await listed.json().catch(() => null)) as {
    remotes?: unknown;
  } | null;
  const remotes = Array.isArray(table?.remotes)
    ? (table.remotes as RemoteRow[])
    : [];
  const serviceId = consoleRemote(remotes, issuer);
  if (serviceId === undefined) throw coded("cloud_not_registered");
  const readOnly = input.role === "viewer";
  const label = input.label.trim().slice(0, 128);
  const created = await channel.request(
    sourceId,
    `/api/sources/remotes/${encodeURIComponent(serviceId)}/links`,
    {
      method: "POST",
      body: {
        serviceId,
        workspaceId: "",
        target: "host",
        ...(readOnly ? { readOnly: true } : {}),
        role: input.role,
        ttlMs: input.ttlMs,
        maxUses: input.maxUses,
        ...(label === "" ? {} : { label }),
      },
    },
  );
  if (!created.ok) throw coded(await refusalCode(created));
  const answer = (await created.json().catch(() => null)) as {
    url?: unknown;
  } | null;
  const url = answer?.url;
  if (typeof url !== "string" || !url.startsWith(`${originOf(issuer)}/j/`))
    throw coded("e2e_device_unavailable");
  return url;
}
