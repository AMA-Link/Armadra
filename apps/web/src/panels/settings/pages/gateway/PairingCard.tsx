import * as React from "react";
import { Copy, Download, RefreshCw } from "lucide-react";
import { toast } from "@/ui/toast";
import type { ConnectOffer } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { encodeQr, qrPath } from "../../../../host/qr";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Spinner } from "@/ui/spinner";

/** 二维码四周留四个模块的静区（规范要求），否则贴着卡片边扫不出来。 */
const QUIET = 4;

/**
 * 白底黑码，不随主题变（设计系统 §5.12：扫码可靠性优先）。整块图一条 path。
 */
export function QrImage({
  text,
  label,
  dimmed = false,
  size = 200,
}: {
  text: string;
  label: string;
  dimmed?: boolean;
  /** 边长（px）；连接手机的码放大到 240，装得下三个来源加两个签发方。 */
  size?: number;
}) {
  const code = React.useMemo(() => encodeQr(text), [text]);
  if (!code) return null;
  const extent = code.size + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-text={text}
      viewBox={`${-QUIET} ${-QUIET} ${extent} ${extent}`}
      shapeRendering="crispEdges"
      width={size}
      height={size}
      className={`shrink-0 rounded-control transition-opacity ${dimmed ? "opacity-20" : ""}`}
    >
      <rect x={-QUIET} y={-QUIET} width={extent} height={extent} fill="white" />
      <path d={qrPath(code)} fill="black" />
    </svg>
  );
}

/** `m:ss`。 */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 每秒走一次的「现在」；`active` 为假时停表。 */
function useNow(active: boolean, initial?: number): number {
  const [now, setNow] = React.useState(() => initial ?? Date.now());
  React.useEffect(() => {
    if (!active || initial !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, initial]);
  return initial ?? now;
}

export interface PairingCardProps {
  /** 刚铸的 offer（契约 §99）；还没有是 `null`。 */
  offer: ConnectOffer | null;
  /** 正在铸。 */
  busy: boolean;
  /** `GET /ca.crt` 的地址；没有 CA 可发时为 `null`。 */
  caHref: string | null;
  onNewOffer(): void;
  /** 展示页用：钉住时钟。 */
  now?: number;
}

/**
 * 「连接手机」的内容（对话框 {@link PairingDialog}）：一张二维码 · 地址 · 复制链接 /
 * 新配对码 · 配对码与倒计时 · 指纹与 CA 下载（设计系统 §5.12）。
 *
 * 一张码装直连与中转两半（契约 §99），哪一半在场由核心定；二维码文本就是 `offer.uri`。
 * 票两分钟一次性，私网档位上同时有一枚 8 位配对码（§24），与票同生同灭，过期时随倒计
 * 时一起收起。归零后图变淡、按钮变成主按钮；不自动续，免得一张开着没人看的页面每
 * 两分钟铸一张票。
 */
export function PairingCard({
  offer,
  busy,
  caHref,
  onNewOffer,
  now: fixedNow,
}: PairingCardProps) {
  const t = useT();
  const direct = offer?.direct ?? null;
  const now = useNow(offer !== null, fixedNow);
  const remaining = (offer?.expiresAtMs ?? 0) - now;
  const expired = offer !== null && remaining <= 0;

  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (direct === null) return;
    try {
      await navigator.clipboard.writeText(direct.webUrl);
      // 文字替换式反馈：按钮上的字换成「已复制」，不弹 toast。
      setCopied(true);
    } catch {
      toast.error(t("gateway.pair.copyFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="flex size-[240px] shrink-0 items-center justify-center self-center sm:self-start">
        {offer ? (
          <QrImage
            text={offer.uri}
            label={t("gateway.pair.qr")}
            dimmed={expired}
            size={240}
          />
        ) : busy ? (
          <Spinner aria-label={t("gateway.pairCode.new")} />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {direct && (
          <p className="break-all font-mono text-body select-text">
            {direct.origins[0]}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {direct && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={expired}
              onClick={() => void copy()}
            >
              <Copy data-icon="inline-start" />
              {copied ? t("gateway.pair.copied") : t("gateway.pair.copy")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={expired || !offer ? "default" : "outline"}
            disabled={busy}
            onClick={onNewOffer}
          >
            <RefreshCw data-icon="inline-start" />
            {t("gateway.pairCode.new")}
          </Button>
        </div>
        {offer && (
          <div
            className="flex flex-wrap items-center gap-2 text-meta tabular-nums"
            aria-live="off"
          >
            {direct?.code && !expired && (
              <>
                <span className="text-muted-foreground">
                  {t("gateway.pairCode.label")}
                </span>
                <Kbd
                  persistent
                  data-pairing-code
                  className="h-5 px-1.5 font-mono text-body tracking-[0.12em] text-foreground select-text"
                >
                  {direct.code}
                </Kbd>
              </>
            )}
            <span
              className={expired ? "text-destructive" : "text-muted-foreground"}
            >
              {expired
                ? t("gateway.pair.expired")
                : direct?.code
                  ? countdown(remaining)
                  : t("gateway.pair.expiresIn", {
                      time: countdown(remaining),
                    })}
            </span>
          </div>
        )}
        {direct && (
          <div className="mt-auto flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3">
            <div className="min-w-0 text-meta">
              <span className="text-muted-foreground">
                {t("gateway.fingerprint")}
              </span>
              <p className="mt-1 break-all font-mono text-caption leading-4 select-text">
                {groupFingerprint(direct.fingerprint)}
              </p>
            </div>
            {caHref && (
              <Button asChild size="sm" variant="ghost" className="w-fit">
                <a href={caHref} download="armadra-ca.crt">
                  <Download data-icon="inline-start" />
                  {t("gateway.ca.download")}
                </a>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 64 位十六进制按两位一组、冒号分开，和系统证书详情里的写法一样，好对照。 */
export function groupFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":");
}
