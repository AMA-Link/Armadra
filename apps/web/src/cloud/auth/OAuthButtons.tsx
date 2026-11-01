import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { useCloudApi } from "../api/context";
import { describeFailure } from "../api/errors";
import { external, rememberOAuthNext } from "./redirect";
import type { OAuthProvider } from "./sign-in-options";

/** 回跳地址：提供方授权完回到控制台这一页（服务端只认 `APP_ORIGIN/login/oauth/<提供方>`）。 */
export const oauthRedirectUri = (provider: OAuthProvider) =>
  `${window.location.origin}/login/oauth/${provider}`;

/** 授权地址只跟 http(s)：服务端答的是 URL，`javascript:` 之类不跳。 */
function followable(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * 「使用 GitHub / Google 继续」：存 `next`，`auth.oauthStart` 取授权地址，整页跳过去。
 * 回跳页是 `/login/oauth/:provider`（`OAuthCallbackPage`）。
 */
export function OAuthButtons({
  providers,
  next,
}: {
  providers: readonly OAuthProvider[];
  next: string | null;
}) {
  const t = useT();
  const api = useCloudApi();
  const [busy, setBusy] = React.useState<OAuthProvider | null>(null);
  const [error, setError] = React.useState("");

  const start = async (provider: OAuthProvider) => {
    if (busy !== null) return;
    setBusy(provider);
    setError("");
    try {
      rememberOAuthNext(next);
      const answer = await api.client.auth.oauthStart({
        provider,
        redirectUri: oauthRedirectUri(provider),
      });
      if (!followable(answer.authorizationUrl)) {
        setError(describeFailure(new Error("bad authorization url")));
        setBusy(null);
        return;
      }
      // 整页跳走：按钮保持转圈，直到页面被换掉。
      external.go(answer.authorizationUrl);
    } catch (failure) {
      setError(describeFailure(failure));
      setBusy(null);
    }
  };

  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          disabled={busy !== null && busy !== provider}
          loading={busy === provider}
          onClick={() => void start(provider)}
        >
          {t(`cloud.auth.${provider}`)}
        </Button>
      ))}
      {error !== "" && (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
    </div>
  );
}
