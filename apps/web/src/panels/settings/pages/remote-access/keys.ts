import * as React from "react";
import {
  QueryClientContext,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  listSources,
  notifyShellSourcesChanged,
} from "../../../../api/remote-services";
import { reloadIntoSettings } from "../../../../sources/bootstrap";
import { RELAY_PENDING_KEY, SHARE_STATUS_KEY } from "../../RemoteShare";
import { groupFingerprint } from "../gateway/PairingCard";

export const SOURCES_QUERY_KEY = ["sources", "list"] as const;
/** 中转账号能不能改口令（按 serviceId 分）。 */
export const PASSWORD_CHANGEABLE_KEY = [
  "sources",
  "passwordChangeable",
] as const;

/** 设置导航里的分区 id（`nav.ts`）。 */
export const REMOTE_SECTION = "remoteAccess";

/** 地址的主机部分（显示用）；不是合法地址就原样。 */
export function hostOf(issuer: string): string {
  try {
    return new URL(issuer).host || issuer;
  } catch {
    return issuer;
  }
}

/** 指纹短码：前 8 位，按两位一组。 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint === "" ? "" : groupFingerprint(fingerprint.slice(0, 8));
}

/** 本机源表；设置页各处共用一份缓存。 */
export function useSourceTable() {
  return useQuery({
    queryKey: SOURCES_QUERY_KEY,
    queryFn: listSources,
    retry: false,
  });
}

/**
 * 这台电脑的名字（源表里本机那一行）；还没取到、读不到或外面没有
 * QueryClientProvider（个别页的单测）是空串。
 */
export function useLocalName(): string {
  // 有没有 Provider 在一个组件实例里不会变：按它跳过查询不会打乱 hook 顺序。
  if (React.useContext(QueryClientContext) === undefined) return "";
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useLocalNameQuery();
}

function useLocalNameQuery(): string {
  const table = useSourceTable();
  return (
    table.data?.sources
      .find((source) => source.kind === "local")
      ?.label.trim() ?? ""
  );
}

/**
 * 源表变了之后的收尾：重读、告诉桌面壳；壳说新来源要重载页面才放行（CSP），
 * 就回到这一页重载。
 */
export function useSourceTableChanged() {
  const client = useQueryClient();
  return React.useCallback(async () => {
    await client.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
    void client.invalidateQueries({ queryKey: SHARE_STATUS_KEY });
    void client.invalidateQueries({ queryKey: RELAY_PENDING_KEY });
    if (await notifyShellSourcesChanged()) reloadIntoSettings(REMOTE_SECTION);
  }, [client]);
}
