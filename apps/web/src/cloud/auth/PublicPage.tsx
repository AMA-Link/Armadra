import type { RouteId, RouteMatch } from "../router";
import { navigate } from "../router";
import { InvitePage } from "./InvitePage";
import { LoginPage } from "./LoginPage";
import { RegisterPage } from "./RegisterPage";
import { ResetPage } from "./ResetPage";
import { VerifyPage } from "./VerifyPage";
import { safeNext } from "./redirect";

/** 有页面的公开路由（`/device` 另批）：这些路由不取会话，未登录也能打开。 */
const PUBLIC_PAGES: ReadonlySet<RouteId> = new Set([
  "login",
  "register",
  "verify",
  "reset",
  "invite",
]);

export const hasPublicPage = (match: RouteMatch | null): match is RouteMatch =>
  match !== null && PUBLIC_PAGES.has(match.id);

/** 登录 / 注册成功后的落点：`next`（邀请把 `#` 令牌带回去），没有就回概览，运营登录回 `/ops`。 */
function landing(match: RouteMatch): string {
  const next = safeNext(match.query.get("next"));
  const operator = match.query.get("scope") === "operator";
  const target = next ?? (operator ? "/ops" : "/");
  return next?.startsWith("/invite/") ? target + window.location.hash : target;
}

/**
 * 公开页的分发。`finish(path)` 由上层给：清缓存、重新取会话、再跳转。
 */
export function PublicPage({
  match,
  finish,
}: {
  match: RouteMatch;
  finish: (path: string) => void;
}) {
  const next = safeNext(match.query.get("next"));
  const hash = next?.startsWith("/invite/") ? window.location.hash : "";
  switch (match.id) {
    case "login":
      return (
        <LoginPage
          operator={match.query.get("scope") === "operator"}
          next={next}
          hash={hash}
          onSignedIn={() => finish(landing(match))}
        />
      );
    case "register":
      return (
        <RegisterPage
          next={next}
          hash={hash}
          onSignedIn={() => finish(landing(match))}
        />
      );
    case "verify":
      return <VerifyPage onContinue={() => finish("/")} />;
    case "reset":
      return <ResetPage onSignIn={() => navigate("/login")} />;
    case "invite":
      return (
        <InvitePage
          invitationId={match.params.id ?? ""}
          onDone={() => finish("/")}
        />
      );
    default:
      return null;
  }
}
