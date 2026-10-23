import * as React from "react";

import type { RouteId, RouteMatch } from "../router";
import { navigate } from "../router";
import { DevicePage } from "./DevicePage";
import { InvitePage } from "./InvitePage";
import { LoginPage } from "./LoginPage";
import { RegisterPage } from "./RegisterPage";
import { ResetPage } from "./ResetPage";
import { VerifyPage } from "./VerifyPage";
import { fragmentToken, safeNext, stripFragment } from "./redirect";

/** 有页面的公开路由：这些路由不取会话，未登录也能打开。 */
const PUBLIC_PAGES: ReadonlySet<RouteId> = new Set([
  "login",
  "register",
  "verify",
  "reset",
  "invite",
  "device",
]);

export const hasPublicPage = (match: RouteMatch | null): match is RouteMatch =>
  match !== null && PUBLIC_PAGES.has(match.id);

/** 登录 / 注册成功后的落点：`next`，没有就回概览，运营登录回 `/ops`。 */
function landing(match: RouteMatch): string {
  const next = safeNext(match.query.get("next"));
  const operator = match.query.get("scope") === "operator";
  return next ?? (operator ? "/ops" : "/");
}

/**
 * 公开页的分发。`finish(path)` 由上层给：清缓存、重新取会话、再跳转。
 *
 * 邮件链接的令牌在 `#` 片段里：挂载时读进内存并立刻从地址栏移除。邀请要穿过登录 / 注册再回来，
 * 所以它留在这一层的状态里（登录、注册、邀请共用同一个实例），地址里从不再带令牌。
 */
export function PublicPage({
  match,
  finish,
}: {
  match: RouteMatch;
  finish: (path: string) => void;
}) {
  const [token] = React.useState(() => fragmentToken());
  React.useEffect(() => stripFragment(), []);
  const next = safeNext(match.query.get("next"));
  switch (match.id) {
    case "login":
      return (
        <LoginPage
          operator={match.query.get("scope") === "operator"}
          next={next}
          onSignedIn={() => finish(landing(match))}
        />
      );
    case "register":
      return (
        <RegisterPage next={next} onSignedIn={() => finish(landing(match))} />
      );
    case "verify":
      return <VerifyPage onContinue={() => finish("/")} />;
    case "reset":
      return <ResetPage onSignIn={() => navigate("/login")} />;
    case "invite": {
      const id = match.params.id ?? "";
      return (
        <InvitePage
          invitationId={id}
          token={token}
          onNeedLogin={() =>
            navigate(`/login?next=${encodeURIComponent(`/invite/${id}`)}`, {
              replace: true,
            })
          }
          onDone={() => finish("/")}
        />
      );
    }
    case "device":
      return (
        <DevicePage
          code={match.query.get("code")}
          // 登录后回到 `/device?code=<user_code>`；device_code 页面里从来没有。
          onNeedLogin={(userCode) =>
            navigate(
              `/login?next=${encodeURIComponent(`/device?code=${userCode}`)}`,
              { replace: true },
            )
          }
          onDone={() => finish("/")}
        />
      );
    default:
      return null;
  }
}
