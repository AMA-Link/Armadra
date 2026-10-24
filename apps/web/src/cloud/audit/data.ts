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
  return useInfiniteQuery({
    queryKey: cloudKeys.audit(keyOfSpace(space), {
      range,
      actor,
      host,
      type,
    }),
    initialPageParam: undefined as string | undefined,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) =>
      api.client.audit.list({
        teamId: space.teamId,
        fromMs: Date.now() - RANGE_MS[range],
        limit: AUDIT_PAGE,
        ...(actor ? { actor } : {}),
        ...(host ? { sourceId: host } : {}),
        ...(type ? { action: `${type}.` } : {}),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
