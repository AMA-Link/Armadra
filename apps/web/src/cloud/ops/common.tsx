import * as React from "react";

import { usePreferencesStore, useT } from "@/app/preferences-store";
import { ErrorState } from "@/ui/state";
import { describeFailure } from "../api/errors";

/** `2025年10月9日` / `Oct 9, 2025`，随界面语言。 */
export function useFormatDate(): (ms: number) => string {
  const locale = usePreferencesStore((state) => state.locale);
  return React.useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    return (ms) => format.format(ms);
  }, [locale]);
}

/** 运营动作码（审计里的 `team.suspend` 等）；认不出的原样显示。 */
export function useActionLabel(): (code: string) => string {
  const t = useT();
  return (code) => {
    const key = `cloud.ops.action.${code}`;
    const label = t(key);
    return label === key ? code : label;
  };
}

/** 计划名；认不出的计划原样显示。 */
export function usePlanLabel(): (plan: string) => string {
  const t = useT();
  return (plan) => {
    const key = `cloud.ops.plan.${plan}`;
    const label = t(key);
    return label === key ? plan : label;
  };
}

/** 区块里的取数失败：按码出文案，一个重试。 */
export function OpsError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <ErrorState
      title={describeFailure(error)}
      retryLabel={t("cloud.common.retry")}
      onRetry={onRetry}
    />
  );
}
