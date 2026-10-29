import { useT } from "../../../../app/preferences-store";
import { Badge } from "@/ui/badge";

/** 原生端的平台（契约 §88.7）：主人的这类设备放行后能批准主人的新设备。 */
export const NATIVE_PLATFORMS: ReadonlySet<string> = new Set([
  "desktop",
  "ios",
  "android",
]);
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set([
  ...NATIVE_PLATFORMS,
  "browser",
]);

/** 设备自报的平台，做成徽标；认不得的原样显示。 */
export function PlatformBadge({ platform }: { platform: string }) {
  const t = useT();
  const known = KNOWN_PLATFORMS.has(platform);
  return (
    <Badge variant="outline" translate={known ? undefined : "no"}>
      {known ? t(`e2e.platform.${platform}`) : platform || "—"}
    </Badge>
  );
}

/** 申请人还在查（`devices.list` 没回来）。 */
export const PRINCIPAL_LOADING = "loading";

/**
 * 「放行后，它能批准主人的新设备」：平台是原生端、申请人是主机 owner 时显示。申请人查不到
 * （`undefined`）按是——提示宁多勿少；还在查（{@link PRINCIPAL_LOADING}）时先占位不显示，
 * 免得成员的申请上闪一下。
 */
export function NativeOwnerHint({
  platform,
  principalKind,
}: {
  platform: string;
  principalKind: string | undefined;
}) {
  const t = useT();
  if (!NATIVE_PLATFORMS.has(platform)) return null;
  const loading = principalKind === PRINCIPAL_LOADING;
  if (!loading && principalKind !== undefined && principalKind !== "owner")
    return null;
  return (
    <span
      data-slot="native-owner-hint"
      aria-hidden={loading ? true : undefined}
      className={`basis-full text-meta text-muted-foreground${loading ? " invisible" : ""}`}
    >
      {t("e2e.approve.native")}
    </span>
  );
}
