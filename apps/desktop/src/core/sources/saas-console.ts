/**
 * Armadra 云控制台在客户端的触点（契约 §33.12）：本机主机的授予与邀请、待信任的新设备。
 *
 * 全部走 {@link CloudSignIn} 登录后存进 SecretStore 的会话（`remoteAccess`），访问令牌
 * 只在一次调用里用，不进答案与日志。授予与邀请只对「本机已登记到这个 Armadra 云」
 * 的主机成立（目标主机就是本机的 `sourceId`）。
 *
 * 设备信任：云端只转交请求并记下拒绝（`trust.reject`）；批准在端到端通道里由背书人
 * 输入新设备上显示的校验码完成，校验码从不经过这里，也不上传。
 */

import type {
  CloudAccess as Access,
  CloudGrantCreateInput,
  CloudGrantUpdateInput,
  CloudInviteInput,
  CloudTrustRequest as TrustRequest,
} from "@armadra/shared";

import { CoreFailure, fail } from "../http/errors";
import type { CloudGrant, RemoteClient, RemoteEndpoint } from "./remote-client";
import type { CloudSignInHost } from "./saas-signin";
import type { RemoteRow } from "./store";

/** 这个类要的：登录会话与本机的登记。 */
export type CloudConsoleHost = Pick<
  CloudSignInHost,
  "remoteRow" | "remoteAccess" | "endpoint" | "cloud" | "log" | "remote"
> & { readonly remote: RemoteClient };

interface Ready {
  readonly row: RemoteRow;
  readonly endpoint: RemoteEndpoint;
  readonly accessToken: string;
}

export class CloudConsole {
  constructor(private readonly host: CloudConsoleHost) {}

  private async ready(serviceId: string): Promise<Ready> {
    const { host } = this;
    const row = host.remoteRow(serviceId);
    if (row.kind !== "saas") {
      throw fail("not_implemented", "只有 Armadra 云有授予与邀请");
    }
    const token = await host.remoteAccess(row);
    return {
      row,
      endpoint: host.endpoint(row),
      accessToken: token.accessToken,
    };
  }

  /** 本机在这个云上的 `sourceId`；没登记到它答 `conflict`。 */
  private async hostId(row: RemoteRow): Promise<string> {
    const cloud = this.host.cloud?.();
    if (cloud === undefined || !cloud.registered(row.issuer)) {
      throw fail("conflict", "本机还没有登记到这个远程服务");
    }
    return cloud.sourceId();
  }

  /** 授予与可授予的成员。管不了（不是主机 owner / 团队 admin）时 `canManage = false`。 */
  async access(serviceId: string): Promise<Access> {
    const { host } = this;
    const { row, endpoint, accessToken } = await this.ready(serviceId);
    const sourceId = await this.hostId(row);
    const info = await host.remote.hostInfo(endpoint, accessToken, sourceId);
    let grants: CloudGrant[] = [];
    let canManage = true;
    try {
      grants = await host.remote.listGrants(endpoint, accessToken, sourceId);
    } catch (error) {
      if (!denied(error)) throw error;
      canManage = false;
    }
    let members: Access["members"] = [];
    if (canManage && info.space.kind === "team") {
      try {
        members = await host.remote.teamMembers(
          endpoint,
          accessToken,
          info.space.teamId,
        );
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    return {
      sourceId,
      space: info.space,
      allowGuests: info.allowGuests,
      canManage,
      members: [...members],
      grants,
    };
  }

  async grantCreate(input: CloudGrantCreateInput) {
    const { host } = this;
    const { row, endpoint, accessToken } = await this.ready(input.serviceId);
    const sourceId = await this.hostId(row);
    const grant = await host.remote.createGrant(endpoint, accessToken, {
      sourceId,
      subject: input.subject,
      role: input.role,
      workspaceIds: input.workspaceIds,
      expiresAtMs: input.expiresAtMs,
    });
    host.log.info("granted access to this machine", {
      serviceId: row.serviceId,
      role: input.role,
    });
    return { grant };
  }

  /** 改一条授予（`grants.update`）：新增授予对已有授予的人答 `conflict`，改它走这里。 */
  async grantUpdate(input: CloudGrantUpdateInput) {
    const { host } = this;
    const { endpoint, accessToken } = await this.ready(input.serviceId);
    return {
      grant: await host.remote.updateGrant(
        endpoint,
        accessToken,
        input.grantId,
        {
          role: input.role,
          workspaceIds: input.workspaceIds,
          expiresAtMs: input.expiresAtMs,
        },
      ),
    };
  }

  async grantRevoke(serviceId: string, grantId: string) {
    const { host } = this;
    const { endpoint, accessToken } = await this.ready(serviceId);
    await host.remote.revokeGrant(endpoint, accessToken, grantId);
    return {};
  }

  async invite(input: CloudInviteInput) {
    const { host } = this;
    const { row, endpoint, accessToken } = await this.ready(input.serviceId);
    const email = input.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw fail("bad_request", "邮箱不正确");
    }
    const sourceId = await this.hostId(row);
    const invitation = await host.remote.inviteToHost(endpoint, accessToken, {
      sourceId,
      email,
      role: input.role,
      workspaceIds: input.workspaceIds,
      expiresAtMs: input.expiresAtMs,
    });
    host.log.info("invited someone to this machine", {
      serviceId: row.serviceId,
    });
    return { invitation };
  }

  /** 我能背书的待信任新设备；校验码云端本来就没有。 */
  async trustList(serviceId: string): Promise<{ requests: TrustRequest[] }> {
    const { host } = this;
    const { endpoint, accessToken } = await this.ready(serviceId);
    return {
      requests: await host.remote.trustRequests(endpoint, accessToken),
    };
  }

  async trustReject(serviceId: string, requestId: string) {
    const { host } = this;
    const { endpoint, accessToken } = await this.ready(serviceId);
    await host.remote.rejectTrust(endpoint, accessToken, requestId);
    return {};
  }
}

/** 云端说「你没有这个权限」：不是错误，是页面该收起管理区的信号。 */
function denied(error: unknown): boolean {
  return (
    error instanceof CoreFailure &&
    (error.code === "team_role_insufficient" ||
      error.code === "source_access_denied")
  );
}
