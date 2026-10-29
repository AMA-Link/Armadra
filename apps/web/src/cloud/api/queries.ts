import { QueryClient, useQuery } from "@tanstack/react-query";

import type { ConsoleSession } from "../ConsoleRoot";
import type { TeamRole } from "../shell/model";
import { useCloudApi, useOperatorActive } from "./context";
import { isTransient } from "./errors";
import { cloudKeys } from "./keys";
import type { CloudApi } from "./session";

/** 30 秒内不重拉（云端控制台 §6.2）；4xx 不重试，网络失败与 5xx 最多两次。 */
export function createCloudQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (count, error) => count < 2 && isTransient(error),
      },
    },
  });
}

export const meQuery = (api: CloudApi) => ({
  queryKey: cloudKeys.me,
  queryFn: () => api.client.me.get({}),
});

export const spacesQuery = (api: CloudApi) => ({
  queryKey: cloudKeys.spaces,
  queryFn: () => api.client.me.spaces({}),
});

/** 外壳要的会话：账号（`me.get`）加空间（`me.spaces`）。 */
export function useConsoleSession({ enabled = true } = {}) {
  const api = useCloudApi();
  const me = useQuery({ ...meQuery(api), enabled });
  const spaces = useQuery({ ...spacesQuery(api), enabled });
  const operator = useOperatorActive();

  const error = me.error ?? spaces.error;
  let session: ConsoleSession | null = null;
  if (me.data && spaces.data) {
    session = {
      accountId: me.data.accountId,
      user: {
        name: me.data.displayName,
        email: me.data.email ?? "",
        emailVerified: me.data.emailVerified,
      },
      teams: spaces.data.spaces.flatMap((space) =>
        space.kind === "team"
          ? [
              {
                slug: space.slug,
                name: space.name,
                role: space.role as TeamRole,
              },
            ]
          : [],
      ),
      operator,
      operatorScope: me.data.scopes?.includes("operator") === true,
    };
  }
  return {
    session,
    error,
    loading: session === null && error === null,
    retry: () => {
      void me.refetch();
      void spaces.refetch();
    },
  };
}
