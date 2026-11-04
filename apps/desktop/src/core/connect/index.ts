/**
 * 「连接手机」的一张二维码（契约 §99，AMA-Link/Armadra#749）。
 *
 * `connect.offer` 把两半拼在一起：Gateway 的配对票（直连半，绑定一组来源）和中继的一次性
 * 配对秘密（中转半）。哪一半在场由现状决定：局域网访问开着且有非回环来源才有直连半，
 * 互联网访问开着且登记了签发方才有中转半，两者都没有答 409 `connect_unavailable`。
 *
 * 同一时刻只活一枚 offer：新的先作废旧的（票、短码、秘密）。两半各自一次性、互不作废；
 * 任何一半被兑掉都发 `connect.used`，对话框据此收起。票与秘密只答给调用方，不进审计、
 * 日志与事件。
 *
 * 二维码文本是网页链接 `<网页来源>/#c=2&…`（载荷见 `@armadra/shared` 的 `connect-link`）。
 * 网页来源取 Gateway 自己服务的页面（有直连半且它带着页面产物时），否则取第一个签发方的
 * 网页；两者都没有页面时仍用 Gateway 来源——App 内扫码只读片段，不请求这个来源。
 */

import {
  type ConnectOffer,
  type ConnectPayload,
  connectUrl,
  issuerOrigin,
} from "@armadra/shared";

import { type DomainHandlers, registerProcedures } from "../http/rpc";
import { fail } from "../http/errors";
import type { CoreRequest } from "../http/router";
import type { CoreContext } from "../main";
import { eventStream } from "../events";
import { audit } from "../identity/audit";
import { type GatewayConnectHalf, gatewayDomainOf } from "../gateway";
import { type RelayConnectHalf, relayDomain } from "../relay";
import { relayedBrowserRequest } from "../relay/e2e/routes";

interface Live {
  readonly revoke: () => void;
  readonly detach: () => void;
}

export interface ConnectDeps {
  /** 测试用：两半的来源；缺省取装好的 Gateway 域与中继。 */
  readonly direct?: () => GatewayConnectHalf | undefined;
  readonly relay?: () => Promise<RelayConnectHalf | undefined> | undefined;
}

export class ConnectDomain {
  private live: Live | undefined;

  constructor(
    private readonly context: CoreContext,
    private readonly deps: ConnectDeps = {},
  ) {}

  async offer(request: CoreRequest | undefined): Promise<ConnectOffer> {
    // 二维码里的秘密不绑主体，拿到就能连上这台电脑：浏览器不签（契约 §88.7）。
    if (relayedBrowserRequest(request)) {
      throw fail("forbidden", "连接手机的二维码不能在浏览器里生成");
    }
    this.retire();
    const direct = (
      this.deps.direct ??
      (() => gatewayDomainOf(this.context.server)?.connectHalf())
    )();
    let relay: RelayConnectHalf | undefined;
    try {
      relay = await (this.deps.relay ?? (() => relayDomain()?.connectHalf()))();
    } catch (error) {
      this.context.log.warn("没能铸中转半", {
        error: error instanceof Error ? error.name : "unknown",
      });
      relay = undefined;
    }
    const issuers = (relay?.issuers ?? [])
      .map((one) => issuerOrigin(one))
      .filter((one): one is string => one !== null)
      .slice(0, 2);
    const usable =
      relay !== undefined && issuers.length > 0 ? relay : undefined;
    if (relay !== undefined && usable === undefined) relay.revoke();
    if (direct === undefined && usable === undefined) {
      throw fail(
        "connect_unavailable",
        "局域网访问与互联网访问都没有开，没有可以连接的路",
      );
    }
    const sourceId = direct?.sourceId ?? (usable?.sourceId as string);
    // 两半来自同一个库，hostId 必然相同；万一不同，宁可丢掉中转半。
    const relayHalf =
      usable !== undefined && usable.sourceId === sourceId ? usable : undefined;
    if (usable !== undefined && relayHalf === undefined) usable.revoke();
    const expiresAtMs = Math.min(
      direct?.expiresAtMs ?? Number.POSITIVE_INFINITY,
      relayHalf?.expiresAtMs ?? Number.POSITIVE_INFINITY,
    );
    const payload: ConnectPayload = {
      sourceId,
      expiresAtMs,
      direct:
        direct === undefined
          ? null
          : {
              origins: direct.origins,
              ticket: direct.ticket,
              fingerprint: direct.fingerprint,
            },
      relay:
        relayHalf === undefined
          ? null
          : {
              identityPub: relayHalf.identityPub,
              secret: relayHalf.secret,
              issuers,
            },
    };
    const webOrigin =
      direct !== undefined && (direct.servesWeb || relayHalf === undefined)
        ? (direct.origins[0] as string)
        : (issuers[0] as string);
    const detach: (() => void)[] = [];
    const used = (route: "direct" | "relay") => () => {
      this.publish(route);
    };
    if (direct !== undefined) detach.push(direct.onUsed(used("direct")));
    if (relayHalf !== undefined) detach.push(relayHalf.onUsed(used("relay")));
    this.live = {
      revoke: () => {
        direct?.revoke();
        relayHalf?.revoke();
      },
      detach: () => {
        for (const off of detach) off();
      },
    };
    // 只记哪些半在场、有没有短码；票、秘密与地址都不记。
    audit({
      action: "connect.offer.issue",
      detail: {
        direct: direct !== undefined,
        relay: relayHalf !== undefined,
        code: direct?.code != null,
      },
    });
    return {
      sourceId,
      expiresAtMs,
      uri: connectUrl(webOrigin, payload),
      direct:
        direct === undefined
          ? null
          : {
              origins: [...direct.origins],
              fingerprint: direct.fingerprint,
              code: direct.code,
              webUrl: direct.webUrl,
            },
      relay:
        relayHalf === undefined
          ? null
          : {
              issuers,
              identityFingerprint: relayHalf.identityFingerprint,
            },
    };
  }

  /** core 停下时：作废还活着的那一枚。 */
  close(): void {
    this.retire();
  }

  private retire(): void {
    const live = this.live;
    this.live = undefined;
    if (live === undefined) return;
    live.detach();
    live.revoke();
  }

  private publish(route: "direct" | "relay"): void {
    const watched = eventStream()?.watchedWorkspaces() ?? [];
    for (const workspaceId of watched) {
      this.context.bus.emit("workspace.event", {
        workspaceId,
        event: { type: "connect.used", route },
      });
    }
  }
}

export function install(
  context: CoreContext,
  deps: ConnectDeps = {},
): ConnectDomain {
  const domain = new ConnectDomain(context, deps);
  registerProcedures(context.server, "connect", {
    offer: (_input, call) => domain.offer(call.request),
  } satisfies DomainHandlers<"connect">);
  return domain;
}
