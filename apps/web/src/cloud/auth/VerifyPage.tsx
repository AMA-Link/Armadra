import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { useCloudApi } from "../api/context";
import { describeFailure } from "../api/errors";
import { AuthLayout } from "./AuthLayout";
import { fragmentToken, stripFragment } from "./redirect";

type Stage =
  | { kind: "working" }
  | { kind: "done"; email: string }
  | { kind: "failed"; message: string };

/**
 * `/verify#<令牌>`：邮箱验证与改邮箱确认共用这一页（云端 `mail.go` 两种邮件都指向 `/verify`），
 * 令牌在 `#` 片段里，读出就从地址栏拿掉，再 POST `auth.emailVerify`。
 */
export function VerifyPage({ onContinue }: { onContinue: () => void }) {
  const t = useT();
  const api = useCloudApi();
  const [token] = React.useState(() => fragmentToken());
  const [stage, setStage] = React.useState<Stage>(
    token === ""
      ? { kind: "failed", message: t("cloud.auth.verifyMissing") }
      : { kind: "working" },
  );
  const started = React.useRef(false);

  React.useEffect(() => {
    stripFragment();
    if (token === "" || started.current) return;
    started.current = true;
    api.client.auth.emailVerify({ token }).then(
      (done) => setStage({ kind: "done", email: done.email }),
      (failure: unknown) =>
        setStage({ kind: "failed", message: describeFailure(failure) }),
    );
  }, [api, token]);

  return (
    <AuthLayout
      title={
        stage.kind === "done"
          ? t("cloud.auth.verified")
          : t("cloud.auth.verifyTitle")
      }
      {...(stage.kind === "done"
        ? { subtitle: t("cloud.auth.verifiedAs", { email: stage.email }) }
        : stage.kind === "failed"
          ? { subtitle: stage.message }
          : {})}
    >
      {stage.kind === "working" && (
        <Skeleton className="h-8 w-full" aria-busy="true" />
      )}
      {stage.kind !== "working" && (
        <Button size="lg" className="w-full" onClick={onContinue}>
          {stage.kind === "done" ? t("cloud.auth.continue") : t("auth.signIn")}
        </Button>
      )}
    </AuthLayout>
  );
}
