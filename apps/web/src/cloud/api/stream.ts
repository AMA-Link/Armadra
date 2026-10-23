import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import {
  ME_STREAM_PATH,
  ME_STREAM_PING_MS,
  meStreamEventSchema,
  type MeStreamEvent,
} from "@armadra/platform-protocol/cloud-api";

import { invalidationsFor } from "./keys";
import type { StreamHandlers } from "./session";

/**
 * me-stream（云端控制台 §6.2，cloud-api §6、§32）。`applyMeStreamEvent` 把事件落到查询缓存：
 * 主机上下线与撤销、链接用量就地改，不重拉；其余只把对应的键标为过期并重拉。
 */

interface HostPage {
  sources: { sourceId: string; online: boolean; lastSeenAtMs: number | null }[];
}
type HostList = InfiniteData<HostPage> | undefined;
interface LinkPage {
  links: { linkId: string; uses: number }[];
}

const isKind = (kind: string) => (key: readonly unknown[]) =>
  key[0] === "cloud" && key[2] === kind;

/** 改目录缓存里某台主机；`patch` 答 `null` = 从目录里去掉。 */
function patchHosts(
  client: QueryClient,
  sourceId: string,
  patch: (
    row: HostPage["sources"][number],
  ) => HostPage["sources"][number] | null,
) {
  client.setQueriesData<HostList>(
    { predicate: (query) => isKind("hosts")(query.queryKey) },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          sources: page.sources.flatMap((row) => {
            if (row.sourceId !== sourceId) return [row];
            const next = patch(row);
            return next === null ? [] : [next];
          }),
        })),
      },
  );
}

function patchHostDetail(
  client: QueryClient,
  sourceId: string,
  patch: Partial<HostPage["sources"][number]>,
) {
  client.setQueriesData<{ sourceId: string } | undefined>(
    {
      predicate: (query) =>
        isKind("host")(query.queryKey) && query.queryKey[3] === sourceId,
    },
    (data) => data && { ...data, ...patch },
  );
}

export function applyMeStreamEvent(client: QueryClient, event: MeStreamEvent) {
  switch (event.type) {
    case "sourceOnline": {
      const patch = { online: true, lastSeenAtMs: event.sinceMs };
      patchHosts(client, event.sourceId, (row) => ({ ...row, ...patch }));
      patchHostDetail(client, event.sourceId, patch);
      return;
    }
    case "sourceOffline": {
      const patch = { online: false, lastSeenAtMs: event.atMs };
      patchHosts(client, event.sourceId, (row) => ({ ...row, ...patch }));
      patchHostDetail(client, event.sourceId, patch);
      return;
    }
    case "sourceRevoked":
      // 撤销的主机不再出现在目录里；详情重拉后是「找不到」。
      patchHosts(client, event.sourceId, () => null);
      void client.invalidateQueries({
        predicate: (query) =>
          isKind("host")(query.queryKey) &&
          query.queryKey[3] === event.sourceId,
      });
      return;
    case "linkUsed":
      client.setQueriesData<{ links: LinkPage["links"] } | undefined>(
        { predicate: (query) => isKind("links")(query.queryKey) },
        (data) =>
          data && {
            ...data,
            links: data.links.map((link) =>
              link.linkId === event.linkId
                ? { ...link, uses: link.uses + 1 }
                : link,
            ),
          },
      );
      // 用量已就地加一；其余字段（冻结、到期）留给下次进入时重拉。
      void client.invalidateQueries({
        predicate: (query) => isKind("links")(query.queryKey),
        refetchType: "none",
      });
      return;
    default: {
      // 一次失效：同一个查询被几条规则命中也只重拉一次。
      const matchers = invalidationsFor(event);
      if (matchers.length > 0)
        void client.invalidateQueries({
          predicate: (query) =>
            matchers.some((matches) => matches(query.queryKey)),
        });
    }
  }
}

/** 断线重连后：断线期间的事件丢了，除了运营数据全部标为过期并重拉。 */
export function resyncCloudQueries(client: QueryClient) {
  void client.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "cloud" && query.queryKey[1] !== "ops",
  });
}

export interface MeStreamOptions {
  /** 控制台所在来源（`location.origin`），换成 `ws(s)`。 */
  readonly origin: string;
  /** `me.streamTicket`：30 秒一次性票据。 */
  readonly ticket: () => Promise<{ ticket: string }>;
  readonly createSocket?: (url: string, protocols: string[]) => WebSocket;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * 连 `/v1/me/stream`：用票据做子协议 `armadra-ticket.<t>` 升级；每 30 秒发 `ping`；
 * 断线按 1s、2s…30s 退避重连，重连成功后 `onResync`。不认识的事件类型忽略（§32）。
 */
export function openMeStream(
  options: MeStreamOptions,
  handlers: StreamHandlers,
): () => void {
  const create =
    options.createSocket ??
    ((url: string, protocols: string[]) => new WebSocket(url, protocols));
  const url = `${options.origin.replace(/^http/, "ws")}${ME_STREAM_PATH}`;
  let stopped = false;
  let socket: WebSocket | null = null;
  let pinger: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = RETRY_MIN_MS;
  let opened = false;

  const schedule = () => {
    if (stopped) return;
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };

  function connect() {
    options.ticket().then(
      ({ ticket }) => {
        if (stopped) return;
        const ws = create(url, [`armadra-ticket.${ticket}`]);
        socket = ws;
        ws.onopen = () => {
          delay = RETRY_MIN_MS;
          if (opened) handlers.onResync();
          opened = true;
          pinger = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
          }, ME_STREAM_PING_MS);
        };
        ws.onmessage = (message) => {
          if (typeof message.data !== "string") return;
          let json: unknown;
          try {
            json = JSON.parse(message.data);
          } catch {
            return;
          }
          const parsed = meStreamEventSchema.safeParse(json);
          if (parsed.success) handlers.onEvent(parsed.data);
        };
        ws.onclose = () => {
          clearInterval(pinger);
          socket = null;
          schedule();
        };
      },
      () => schedule(),
    );
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(pinger);
    socket?.close();
  };
}
