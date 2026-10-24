import * as React from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { keyOfSpace } from "../space";
import type { TeamSpace } from "../team/data";
import { RANGE_MS, type AuditFilters } from "./model";

export type AuditEvent = Awaited<
  ReturnType<CloudClient["audit"]["list"]>
>["events"][number];

export const AUDIT_PAGE = 100;

/** 团队审计（云端控制台 §6.2 `audit`）：游标分页，翻筛选时保留上一页内容不闪骨架。 */
export function useAuditEvents(space: TeamSpace, filters: AuditFilters) {
  const api = useCloudApi();
  const { range, actor, host, type } = filters;
  // 起点在首屏（或换筛选）时定下并进查询键：翻页与重拉用同一个 `fromMs`，列表不会随时间漂。
  const fromMs = React.useMemo(
    () => Date.now() - RANGE_MS[range],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 筛选变了才重新定起点
    [range, actor, host, type],
  );
  return useInfiniteQuery({
    queryKey: cloudKeys.audit(keyOfSpace(space), {
      range,
      actor,
      host,
      type,
      fromMs,
    }),
    initialPageParam: undefined as string | undefined,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) =>
      api.client.audit.list({
        teamId: space.teamId,
        fromMs,
        limit: AUDIT_PAGE,
        ...(actor ? { actor } : {}),
        ...(host ? { sourceId: host } : {}),
        ...(type ? { action: `${type}.` } : {}),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
