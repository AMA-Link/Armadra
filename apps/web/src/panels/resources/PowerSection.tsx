/**
 * 防休眠租约（T02，终端宿主设计 §9）。
 *
 * 界面上要说清楚三件事，因为它们经常被混为一谈：
 *
 *  1. **只挡系统空闲睡眠。** 不常亮屏幕，不管合盖，不拦用户自己点睡眠。
 *  2. **租约是申请，不是保证。** 策略不允许或平台没有机制时，租约照样列
 *     出来，只是 `active: false` 并写明原因——「跑一半怎么睡过去了」得能
 *     在这里查到。
 *  3. **策略在设置页改。** 这里只显示当前策略并给一个手动开关。
 */
import { useState } from "react";
import type { PowerState } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { StatusDot } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";
import { toast } from "@/ui/toast";

/** 手动租约的 TTL：面板开着时会跟着采样一起续，关掉后十分钟自然释放。 */
const MANUAL_TTL_SECONDS = 600;

export function PowerSection({
  power,
  onChanged,
}: {
  power: PowerState;
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const manual =
    power.leases.find((lease) => lease.source === "manual") ?? null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const lease = await runtimeApi.acquirePowerLease({
          source: "manual",
          reason: t("resources.power.manualReason"),
          ttlSeconds: MANUAL_TTL_SECONDS,
        });
        // 申请成功但没生效（策略是「从不」）要说出来，而不是让开关默默
        // 停在打开的样子。
        if (!lease.active && lease.blockedBy) {
          toast.warning(t(`resources.power.blocked.${lease.blockedBy}`));
        }
      } else if (manual) {
        await runtimeApi.releasePowerLease(manual.id);
      }
      onChanged();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("resources.power.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-card border border-border p-3">
      <div className="flex items-center gap-2 py-1">
        <Switch
          id="power-manual"
          checked={manual !== null}
          disabled={busy || !power.inhibitor.available}
          onCheckedChange={(next) => void toggle(next)}
        />
        <label htmlFor="power-manual" className="flex-1 text-meta">
          {t("resources.power.manual")}
        </label>
        {!power.inhibitor.available && (
          <span className="shrink-0 text-caption text-muted-foreground">
            {power.inhibitor.detail ?? t("resources.power.unavailable")}
          </span>
        )}
      </div>

      {power.leases.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
          {power.leases.map((lease) => (
            <li key={lease.id} className="flex items-center gap-2 text-meta">
              <StatusDot tone={lease.active ? "done" : "idle"} size={6} />
              <span className="min-w-0 flex-1 truncate">{lease.reason}</span>
              <Badge variant="ghost" className="shrink-0 text-caption">
                {t(`resources.power.source.${lease.source}`)}
              </Badge>
              <span className="shrink-0 text-caption text-muted-foreground">
                {lease.blockedBy
                  ? t(`resources.power.blocked.${lease.blockedBy}`)
                  : t("resources.power.expires", {
                      value: formatRelativeTime(lease.expiresAt),
                    })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
