import type { ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { CaInstallGuide } from "@/panels/settings/pages/gateway/CaInstallGuide";
import { GatewayDevices } from "@/panels/settings/pages/gateway/GatewayDevices";
import { GatewayPanel } from "@/panels/settings/pages/gateway/GatewayPanel";
import { PairingCard } from "@/panels/settings/pages/gateway/PairingCard";
import { InternetRow } from "@/panels/settings/pages/remote-access/InternetRow";
import {
  CA_HREF,
  CURRENT_DEVICE,
  DEVICES,
  EXPIRED_NOW,
  FAILED,
  NOW,
  OFF,
  PAIRING,
  RENEW_FAILED,
  RUNNING,
  STARTING,
} from "../fixtures/gateway";

const noop = () => undefined;

function Sample({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-meta text-muted-foreground">
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * `gateway` 分区（设计展示页 §2.1，设计系统 §5.12）：设置页里真的
 * `GatewayPanel` / `InternetRow` / `PairingCard` / `CaInstallGuide`，喂假数据。
 *
 * 关闭（只有开关一行）· 运行中（开关、互联网访问、手机扫码连接三行；已登记到
 * Armadra 云带空间与「更换」，没登记是「登录 Armadra 云」；扫码对话框里的二维码、
 * 倒计时、指纹与 CA；设备表——当前设备带「当前」、一行正在撤销、底部「加载更多」）·
 * 正在生成证书 · 没能开启 ·
 * ACME 续期失败 · 配对码过期 · 手机配对页的 CA 引导。时钟钉住，截图稳定。
 */
export default function GatewaySection() {
  const t = useT();
  const panel = { internet: false, busy: false, onToggle: noop, onScan: noop };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("gateway.showcase.off")}>
          <GatewayPanel {...panel} status={OFF} />
        </Sample>
        <Sample caption={t("showcase.state.loading")}>
          <GatewayPanel {...panel} status={STARTING} />
        </Sample>
        <Sample caption={t("gateway.showcase.error")}>
          <GatewayPanel {...panel} status={FAILED} />
        </Sample>
        <Sample caption={t("gateway.pair.expired")}>
          <PairingCard
            pairing={PAIRING}
            busy={false}
            origins={[PAIRING.origin]}
            fingerprint={PAIRING.fingerprint}
            caHref={null}
            onNewPairing={noop}
            now={EXPIRED_NOW}
          />
        </Sample>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("gateway.showcase.running")}>
          <GatewayPanel {...panel} internet status={RUNNING}>
            <InternetRow
              state={{
                kind: "cloud",
                space: { kind: "team", teamId: "t1", name: "Acme" },
                tunnel: "ready",
              }}
              onSignIn={noop}
              onChange={noop}
              onStop={noop}
            />
          </GatewayPanel>
          <PairingCard
            pairing={PAIRING}
            busy={false}
            origins={RUNNING.origins}
            fingerprint={PAIRING.fingerprint}
            caHref={CA_HREF}
            onNewPairing={noop}
            now={NOW}
          />
          <GatewayDevices
            devices={DEVICES}
            revoking="dev-ipad"
            onRevoke={noop}
            currentDeviceId={CURRENT_DEVICE}
            hasMore
            onMore={noop}
          />
        </Sample>
        <Sample caption={t("remote.cloud.signIn")}>
          <GatewayPanel {...panel} status={RUNNING}>
            <InternetRow
              state={{ kind: "off", via: "cloud" }}
              onSignIn={noop}
              onChange={noop}
              onStop={noop}
            />
          </GatewayPanel>
        </Sample>
        <Sample caption={t("gateway.acme.renewFailed")}>
          <GatewayPanel {...panel} status={RENEW_FAILED} />
        </Sample>
        <Sample caption={t("gateway.showcase.phone")}>
          <div className="w-full max-w-[390px]">
            <CaInstallGuide href={CA_HREF} defaultOpen platform="ios" />
          </div>
        </Sample>
      </div>
    </div>
  );
}
