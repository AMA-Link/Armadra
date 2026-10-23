import type { TimelineTurnItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { memoRow } from "../row-memo";

export interface TurnFooterProps {
  item: TimelineTurnItem;
  /** 出错后重试；不给就没有按钮。 */
  onRetry?: (() => void) | undefined;
  /** 触顶（max_*）后「继续」。 */
  onContinue?: (() => void) | undefined;
}

/**
 * 回合尾：出错是 Alert 加重试；拒绝是 Alert；取消与触顶是居中一行；正常结束
 * 不画。
 */
function TurnFooterImpl({ item, onRetry, onContinue }: TurnFooterProps) {
  const t = useT();
  if (item.error !== undefined) {
    return (
      <Alert variant="destructive" data-slot="timeline-turn" data-stop="error">
        <AlertTitle className="break-words">
          {item.error.message || t("timeline.turn.failed")}
        </AlertTitle>
        {onRetry !== undefined && (
          <AlertAction>
            <Button size="xs" variant="outline" onClick={onRetry}>
              {t("timeline.turn.retry")}
            </Button>
          </AlertAction>
        )}
      </Alert>
    );
  }
  const reason = item.stopReason;
  if (reason === undefined || reason === "end_turn") return null;
  if (reason === "refusal") {
    return (
      <Alert data-slot="timeline-turn" data-stop="refusal">
        <AlertTitle>{t("timeline.turn.refused")}</AlertTitle>
      </Alert>
    );
  }
  const cancelled = reason === "cancelled";
  return (
    <div
      data-slot="timeline-turn"
      data-stop={reason}
      className="flex items-center justify-center gap-2 py-0.5 text-caption text-muted-foreground"
    >
      <span>
        {t(cancelled ? "timeline.turn.cancelled" : "timeline.turn.limit")}
      </span>
      {!cancelled && onContinue !== undefined && (
        <Button size="xs" variant="outline" onClick={onContinue}>
          {t("timeline.turn.continue")}
        </Button>
      )}
    </div>
  );
}

export const TurnFooter = memoRow(TurnFooterImpl);
