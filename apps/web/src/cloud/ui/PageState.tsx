import { Ban, LogIn, SearchX, TriangleAlert, Wrench } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { localizedFailure } from "../../api/request";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/empty";

/** 整页的五种状态（云端控制台 §3.0）。 */
export type PageStateKind =
  | "error"
  | "forbidden"
  | "notFound"
  | "maintenance"
  | "sessionExpired";

/** 错误码落到哪一种：认不出的都是「按 code 的错误」。 */
export function pageStateKind(code?: string): PageStateKind {
  switch (code) {
    case "forbidden":
    case "team_policy_denied":
      return "forbidden";
    case "not_found":
      return "notFound";
    case "unavailable":
    case "storage_unavailable":
      return "maintenance";
    case "unauthenticated":
    case "session_expired":
    case "session_revoked":
      return "sessionExpired";
    default:
      return "error";
  }
}

/**
 * 整页状态：`Empty` + 一句标题 + 一个按钮。现有 `ErrorState` 只用在行内与区块内。
 * 找不到与没有权限回「概览」、登录过期去「重新登录」，另两种是「重试」；对应回调没给就不画按钮。
 */
export function PageState({
  code,
  kind = pageStateKind(code),
  onRetry,
  onHome,
  onSignIn,
  className,
}: {
  code?: string;
  kind?: PageStateKind;
  onRetry?: () => void;
  onHome?: () => void;
  onSignIn?: () => void;
  className?: string;
}) {
  const t = useT();
  const view = {
    error: {
      Icon: TriangleAlert,
      title: localizedFailure(code, t("error.internal")),
      action: ["cloud.common.retry", onRetry],
    },
    forbidden: {
      Icon: Ban,
      title: localizedFailure(code, t("error.forbidden")),
      action: ["cloud.page.home", onHome],
    },
    notFound: {
      Icon: SearchX,
      title: t("cloud.page.notFound"),
      action: ["cloud.page.home", onHome],
    },
    maintenance: {
      Icon: Wrench,
      title: t("cloud.page.maintenance"),
      action: ["cloud.common.retry", onRetry],
    },
    sessionExpired: {
      Icon: LogIn,
      title: t("cloud.page.sessionExpired"),
      action: ["cloud.page.signIn", onSignIn],
    },
  }[kind] as {
    Icon: typeof SearchX;
    title: string;
    action: [string, (() => void) | undefined];
  };
  const [labelKey, run] = view.action;
  return (
    <Empty data-page-state={kind} className={cn("min-h-[60dvh]", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <view.Icon aria-hidden strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={1}>
          {view.title}
        </EmptyTitle>
      </EmptyHeader>
      {run ? (
        <EmptyContent>
          <Button onClick={run}>{t(labelKey)}</Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
