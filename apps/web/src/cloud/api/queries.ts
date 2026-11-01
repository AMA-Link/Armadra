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

/**
 * 服务端的平台信息（能力位、挑战要求）。取不到不重试：调用方按「口令登录、没有第三方」回退，
 * 不让登录页卡在重试里。
 */
export const platformInfoQuery = (api: CloudApi) => ({
  queryKey: cloudKeys.platformInfo,
  queryFn: () => api.client.platform.info({}),
  retry: false,
});

export function usePlatformInfo() {
  return useQuery(platformInfoQuery(useCloudApi()));
}

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

/**
 * 只有运营会话时的会话（云端控制台 §1.3）：运营 Cookie 独立于普通会话，`me.get` 不认它，
 * 所以在 `/ops` 下普通会话没了，就用 `auth.refresh { scope: "operator" }` 答复里的账号画外壳
 * （顺带取回刷新页面后丢掉的运营 CSRF 值）。续不上答 `error`，由调用方回登录。
 */
export function useOperatorOnlySession({ enabled }: { enabled: boolean }) {
  const api = useCloudApi();
  const operator = useOperatorActive();
  const account = useQuery({
    queryKey: cloudKeys.ops("account"),
    queryFn: async () =>
      (await api.ops.auth.refresh({ scope: "operator" })).session.account,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  let session: ConsoleSession | null = null;
  if (enabled && account.data && operator)
    session = {
      accountId: account.data.accountId,
      user: {
        name: account.data.displayName,
        email: account.data.email ?? "",
        emailVerified: account.data.emailVerified,
      },
      teams: [],
      operator: true,
      operatorScope: true,
    };
  return {
    session,
    /** 续不上运营会话。 */
    failed: enabled && account.isError,
    /** 取到过账号、运营会话后来到期（运营客户端续不上清掉了 CSRF）。 */
    expired: enabled && account.data !== undefined && !operator,
  };
}
