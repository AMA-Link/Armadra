import { useEffect, useRef } from "react";

import {
  hasPairingFragment,
  type IdentitySession,
} from "../../../../api/identity";
import { useT } from "../../../../app/preferences-store";
import { useHostConnection } from "../../../../host/use-host-connection";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { HostIdentityPanel } from "../HostIdentityPanel";

/** 带着配对票时检查失败的自动重试：次数与间隔。 */
const AUTO_RETRIES = 2;
const AUTO_RETRY_MS = 1_000;

/**
 * 账号与设备 → 设备登录（#708，原「设备与会话」页的上半）：这台设备的身份会话与配对。
 *
 * 设备登录要先确认服务身份（`hello`）才会取走配对票，所以挂上就查一次连接。配对链接
 * `…/#pair=<票>` 由 `use-link-fragments` 打开到这一页；页面开着时地址栏才换上一张新票
 * （同一标签页再贴一次配对链接只改片段、不重载）也要接住。`epoch` 变了重挂身份面
 * （撤销了这台设备自己之后重新取一次会话）。
 */
export function DeviceSignIn({
  epoch,
  onSession,
  ticketForm = true,
}: {
  epoch: number;
  onSession(session: IdentitySession | null): void;
  /** 同一页正画着登录表单时不再给手填配对票的表单。 */
  ticketForm?: boolean;
}) {
  const t = useT();
  const { state, check } = useHostConnection();
  const autoRetries = useRef(0);
  // 重试时告警原位留着（按钮转 loading），不换成更高的骨架再换回来：点一下页面不抖
  const lastError = useRef<string | null>(null);
  if (state.status === "error") lastError.current = state.messageKey;
  else if (state.status === "connected") lastError.current = null;
  useEffect(() => {
    void check();
    const onLink = () => {
      if (!hasPairingFragment()) return;
      autoRetries.current = 0;
      void check();
    };
    window.addEventListener("hashchange", onLink);
    return () => window.removeEventListener("hashchange", onLink);
  }, [check]);
  // 带着票却没检查成功（服务刚起、第一次握手慢）：票还在地址栏里，隔一秒再
  // 试，最多两次。
  useEffect(() => {
    if (state.status !== "error" || !hasPairingFragment()) return;
    if (autoRetries.current >= AUTO_RETRIES) return;
    autoRetries.current += 1;
    const timer = setTimeout(() => void check(), AUTO_RETRY_MS);
    return () => clearTimeout(timer);
  }, [state, check]);

  if (state.status === "connected")
    return (
      <HostIdentityPanel
        key={epoch}
        hello={state.hello}
        onSession={onSession}
        ticketForm={ticketForm}
      />
    );
  const retrying = state.status === "checking" && lastError.current !== null;
  if (state.status === "error" || retrying) {
    const messageKey =
      state.status === "error" ? state.messageKey : lastError.current;
    return (
      <Alert variant="destructive" role="status" aria-live="polite">
        <AlertTitle className="font-normal break-words">
          {messageKey === null ? null : t(messageKey)}
        </AlertTitle>
        <AlertAction>
          <Button
            size="sm"
            variant="secondary"
            loading={retrying}
            onClick={() => void check()}
          >
            {t("host.check")}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return <Skeleton className="h-24 w-full" />;
}
