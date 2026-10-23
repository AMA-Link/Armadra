import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCloudApi } from "../api/context";
import type { CloudClient } from "../api/client";
import { cloudKeys } from "../api/keys";
import { keyOfSpace, spaceWire, type CloudSpace } from "../space";

/** 链接列表的数据层（云端控制台 §6.2 `links`），个人与团队空间共用；`sourceId` 缺省 = 整个空间。 */
export type LinkRow = Awaited<
  ReturnType<CloudClient["links"]["list"]>
>["links"][number];

export function useLinks(space: CloudSpace, sourceId?: string) {
  const api = useCloudApi();
  return useQuery({
    queryKey: cloudKeys.links(keyOfSpace(space), { sourceId }),
    queryFn: () =>
      api.client.links.list({
        space: spaceWire(space),
        ...(sourceId === undefined ? {} : { sourceId }),
      }),
  });
}

export function useUpdateLinkNote(space: CloudSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, label }: { linkId: string; label: string }) =>
      api.client.links.update({ linkId, label }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "links"],
      }),
  });
}

export function useRevokeLink(space: CloudSpace) {
  const api = useCloudApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.client.links.revoke({ linkId }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "links"],
      }),
  });
}
