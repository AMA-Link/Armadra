import type { RouteEntry } from "./routes";

/** 从 `routes.ts` 拆出的三张「同前缀、按方法」的子表；`ROUTES` 在原位置展开它们。 */
/** `/api/workflows/*` 的路由（契约 §15、§43.2–§43.3）：路径与它收的方法。 */
export const WORKFLOW_ROUTES: readonly RouteEntry[] = (
  [
    ["/drafts", ["GET"]],
    ["/drafts/{draftId}", ["GET"]],
    ["/drafts/{draftId}/confirm", ["POST"]],
    ["/drafts/{draftId}/discard", ["POST"]],
    ["/templates", ["GET", "POST"]],
    ["/templates/{templateId}", ["GET", "PUT", "DELETE"]],
    ["/templates/{templateId}/upgrade-schedules", ["POST"]],
    ["/runs", ["GET", "POST"]],
    ["/runs/{runId}", ["GET"]],
    ["/runs/{runId}/cancel", ["POST"]],
    ["/runs/{runId}/gates/{stepId}", ["POST"]],
    ["/tasks", ["GET"]],
    ["/tasks/{taskId}/retry", ["POST"]],
  ] as const
).map(([path, methods]) => ({
  path: `/api/workflows${path}`,
  methods,
  surface: "runtime",
  implemented: true,
}));

/** `/api/forge/repos/{host}/{owner}/{name}/*` 的路由（契约 §41）：路径与它收的方法。 */
export const FORGE_REPO_ROUTES: readonly RouteEntry[] = (
  [
    ["", ["GET"]],
    ["/issues", ["GET"]],
    ["/issues/{number}", ["GET", "PATCH"]],
    ["/pulls", ["GET", "POST"]],
    ["/pulls/{number}", ["GET"]],
    ["/pulls/{number}/files", ["GET"]],
    ["/pulls/{number}/checks", ["GET"]],
    ["/pulls/{number}/merge", ["POST"]],
    ["/merge-options", ["GET"]],
    ["/pulls/{number}/auto-merge", ["POST", "DELETE"]],
    ["/pulls/{number}/branch", ["DELETE"]],
  ] as const
).map(([path, methods]) => ({
  path: `/api/forge/repos/{host}/{owner}/{name}${path}`,
  methods,
  surface: "runtime",
  implemented: true,
}));

/** `/api/sources/remotes/{serviceId}/*` 的路由（契约 §33.2、§33.6、§61、§63）。 */
export const REMOTE_SERVICE_ROUTES: readonly RouteEntry[] = (
  [
    ["", ["PUT", "DELETE"]],
    ["/poll", ["POST"]],
    ["/sources", ["GET"]],
    ["/spaces", ["GET"]],
    ["/register", ["POST"]],
    ["/mount", ["POST"]],
    ["/session", ["POST"]],
    ["/logout", ["POST"]],
    ["/password", ["POST"]],
  ] as const
).map(([path, methods]) => ({
  path: `/api/sources/remotes/{serviceId}${path}`,
  methods,
  surface: "runtime",
  implemented: true,
}));
