import { useT } from "@/app/preferences-store";
import { ErrorState } from "@/ui/state";
import { describeFailure } from "../api/errors";

/** 区块里的取数失败：按码出文案，一个重试（整页用 `PageState`）。 */
export function InlineError({
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
