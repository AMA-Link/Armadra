import type { CostPoint, CostWindow } from "@armadra/shared";
import { X } from "lucide-react";

import { useT } from "../../app/preferences-store";
import { formatTokens, formatUsd, totalTokens } from "../../lib/cost";
import { IconButton } from "@/ui/icon-button";
import { Tray, TrayCard, TrayHeader, TrayValue } from "@/ui/tray";
import { pointLabel, type UsageMetric } from "./metrics";

/**
 * 用量总览托盘（设计系统 §5.17）：Token 与费用两张托盘内卡，当前指标的那张带品牌边。
 * 选中某一天时托盘头显示那一天并给一枚清除钮，数字跟着换。
 */
export function MetricCards({
  totals,
  point,
  metric,
  onClear,
}: {
  totals: CostWindow;
  point: CostPoint | null;
  metric: UsageMetric;
  onClear: () => void;
}) {
  const t = useT();
  const source = point ?? totals;
  return (
    <Tray data-slot="usage-metrics">
      {point && (
        <TrayHeader
          label={pointLabel(point.key)}
          actions={
            <IconButton
              label={t("usage.selection.clear")}
              size="inline"
              onClick={onClear}
            >
              <X />
            </IconButton>
          }
        />
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <TrayCard
          data-slot="usage-card"
          data-metric="tokens"
          data-active={metric === "tokens"}
          data-selected={metric === "tokens"}
        >
          <span className="text-meta text-muted-foreground">
            {t("usage.metric.tokens")}
          </span>
          <TrayValue
            label={t("usage.metric.tokens")}
            value={totalTokens(source.tokens)}
            fromZero={false}
            format={(value) =>
              t("usage.cost.tokenCount", { value: formatTokens(value) })
            }
          />
        </TrayCard>
        <TrayCard
          data-slot="usage-card"
          data-metric="cost"
          data-active={metric === "cost"}
          data-selected={metric === "cost"}
        >
          <span className="text-meta text-muted-foreground">
            {t("usage.metric.cost")}
          </span>
          <TrayValue
            label={t("usage.metric.cost")}
            value={source.costUsd ?? 0}
            fromZero={false}
            format={(value) => formatUsd(value)}
          />
        </TrayCard>
      </div>
    </Tray>
  );
}
