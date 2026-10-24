import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { tp } from "../i18n-plural";
import { RelativeTime } from "./RelativeTime";

const DAY = 86_400_000;
const SOON_DAYS = 7;

/** 到期（云端控制台 §3.0 时间）：已过期给徽标，7 天内写「N 天后到期」并用警示色，更远的给相对时间。 */
export function Expiry({ ms }: { ms: number }) {
  const t = useT();
  const left = ms - Date.now();
  if (left <= 0)
    return <Badge variant="outline">{t("cloud.common.expired")}</Badge>;
  if (left <= SOON_DAYS * DAY)
    return (
      <span className="text-warn-text">
        {tp("cloud.common.expiresIn", Math.max(1, Math.ceil(left / DAY)))}
      </span>
    );
  return <RelativeTime ms={ms} />;
}
