import { useT } from "@/app/preferences-store";

/** 本机认不了你的账号、或认你作成员、或还没登录 Armadra 云：在主机上补登录（设计 saas-host-open §2.6）。 */
export function FixCommand({ issuer }: { issuer: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 text-meta">
      <p>{t("cloud.host.fixServer")}</p>
      <code className="rounded-control bg-muted px-2 py-1 font-mono break-all select-all">
        {`armadra-server cloud login --issuer ${issuer}`}
      </code>
      <p className="text-muted-foreground">{t("cloud.host.fixDesktop")}</p>
    </div>
  );
}
