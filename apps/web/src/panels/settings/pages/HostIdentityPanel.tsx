import { useEffect, useId, useRef, useState } from "react";

import {
  hasSessionCapability,
  IdentityRequestError,
  IdentityTransportError,
  logoutIdentity,
  pairIdentity,
  resumeIdentity,
  takePairingTicket,
  type IdentityHello,
  type IdentitySession,
} from "../../../api/identity";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { nativeSessionFailureKey } from "../../../host/native-session";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { ValueLoadable } from "../SettingsLoadable";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";

export interface HostIdentityPanelProps {
  hello?: IdentityHello;
  /**
   * 会话变了（取回、配对、登出）时报一次。已配对设备表只有一份，在对外服务
   * 那一块（`GatewayDevices`）；它靠这个知道哪一行是「当前」、能不能撤销。
   */
  onSession?(session: IdentitySession | null): void;
}

/** 身份面用不上的原因；`null` 表示可以用。 */
function availability(hello: IdentityHello | undefined): string | null {
  if (!hello?.sourceId || !hello.hostInstanceId)
    return "hostIdentity.checkRequired";
  if (!hasSessionCapability(hello)) return "hostIdentity.unsupported";
  return null;
}

function failureKey(error: unknown): string {
  // 壳里票据由壳自己签；它的失败有自己那句话，好让人知道该看哪一边。
  const native = nativeSessionFailureKey(error);
  if (native) return native;
  if (error instanceof IdentityTransportError)
    return "hostIdentity.error.network";
  if (!(error instanceof IdentityRequestError))
    return "hostIdentity.error.response";
  if (error.status === 401) return "hostIdentity.error.auth";
  if (error.status === 403) return "hostIdentity.error.permission";
  if (error.status === 409) return "hostIdentity.error.conflict";
  if (error.status === 400) return "hostIdentity.error.invalid";
  return "hostIdentity.error.network";
}

export function HostIdentityPanel({
  hello,
  onSession,
}: HostIdentityPanelProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const id = useId();
  const unavailable = availability(hello);
  const ready = unavailable === null;
  const working = useRef(false);
  const generation = useRef(0);
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const live = (mark: number) => generation.current === mark;

  // 报给父组件的回调不进 effect 依赖：它每次渲染都是新函数。
  const report = useRef(onSession);
  report.current = onSession;

  async function accept(mark: number, value: IdentitySession | null) {
    if (!live(mark)) return;
    setSession(value);
    report.current?.(value);
  }

  async function run(action: (mark: number) => Promise<void>) {
    const mark = generation.current;
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(mark);
    } catch (failure) {
      if (live(mark)) setError(failureKey(failure));
    } finally {
      if (live(mark)) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    generation.current += 1;
    const mark = generation.current;
    working.current = false;
    setSession(null);
    report.current?.(null);
    setTicket("");
    setError(null);
    setNotice(null);
    setBusy(false);
    if (!ready) return;
    // 服务器壳把票放在地址栏的片段里（`…/#pair=<票>`）。读到就直接配对：
    // 让人把一串票自己复制一遍，只会多一次出错的机会。
    const pending = takePairingTicket();
    void run(async (current) =>
      accept(
        current,
        pending ? await pairIdentity(pending) : await resumeIdentity(),
      ),
    );
    return () => {
      generation.current += 1;
    };
    // 这条会话只跟着「身份面能不能用」走，不跟着语言或响应对象的身份走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 页面开着时地址栏换上一张新票（同一标签页再贴一次配对链接只改片段）：
  // 可用的身份面照样取走它配对，不等下一次挂载。
  useEffect(() => {
    if (!ready) return;
    const onLink = () => {
      if (working.current) return;
      const pending = takePairingTicket();
      if (!pending) return;
      void run(async (current) => accept(current, await pairIdentity(pending)));
    };
    window.addEventListener("hashchange", onLink);
    return () => window.removeEventListener("hashchange", onLink);
    // 同上：只跟着「身份面能不能用」走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const expiry =
    session && session.expiresAtUnixMs > 0
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(session.expiresAtUnixMs)
      : "—";

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-(--space-group)"
    >
      <h3
        id={`${id}-title`}
        className="px-0.5 text-body font-medium text-foreground"
      >
        {t("hostIdentity.title")}
      </h3>
      {unavailable ? (
        <Alert role="status">
          <AlertTitle className="font-normal break-words">
            {t(unavailable)}
          </AlertTitle>
        </Alert>
      ) : (
        <SettingsGroup>
          <div className="min-w-0" aria-busy={busy}>
            {error ? (
              <div className="px-4 py-2">
                <Alert variant="destructive" role="status" aria-live="polite">
                  <AlertTitle className="font-normal break-words">
                    {t(error)}
                  </AlertTitle>
                </Alert>
              </div>
            ) : (
              <div className="px-4 py-2">
                <ValueLoadable loading={busy && !session} className="h-5 w-56">
                  <div
                    role="status"
                    aria-live="polite"
                    className="break-words text-meta text-muted-foreground"
                  >
                    {t(
                      busy
                        ? "hostIdentity.busy"
                        : (notice ??
                            (!session
                              ? "hostIdentity.signedOut"
                              : "hostIdentity.current")),
                    )}
                  </div>
                </ValueLoadable>
              </div>
            )}
          </div>
          {!session ? (
            <form
              className="flex min-w-0 flex-col gap-3 px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !ticket.trim()) return;
                const material = ticket;
                setTicket("");
                void run(async (mark) =>
                  accept(mark, await pairIdentity(material)),
                );
              }}
            >
              <label
                htmlFor={`${id}-ticket`}
                className="block text-body font-medium"
              >
                {t("hostIdentity.ticket")}
              </label>
              <Textarea
                id={`${id}-ticket`}
                rows={3}
                maxLength={8192}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={ticket}
                disabled={busy}
                onChange={(event) => setTicket(event.target.value)}
                className="min-w-0 resize-y text-meta"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !ticket.trim()}
                >
                  {t("hostIdentity.pair")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async (mark) =>
                      accept(mark, await resumeIdentity()),
                    )
                  }
                >
                  {t("hostIdentity.restore")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <SettingsRow
                label={t("hostIdentity.current")}
                footnote={session.device.deviceId}
              >
                <span className="min-w-0 break-words text-body font-medium">
                  {session.device.displayName} · {t("hostIdentity.owner")}
                </span>
              </SettingsRow>
              <SettingsRow label={t("hostIdentity.expires")}>
                <span className="text-body tabular-nums">{expiry}</span>
              </SettingsRow>
              <details className="px-4 py-2">
                <summary className="cursor-pointer text-body focus-visible:outline-2 focus-visible:outline-ring">
                  {t("hostIdentity.permissions")}
                </summary>
                <ul className="mt-2 space-y-2 text-meta">
                  {session.scopes.map((scope, index) => (
                    <li
                      key={`${scope.permission}-${index}`}
                      className="break-words"
                    >
                      {t(`hostIdentity.scope.${scope.permission}`)} ·{" "}
                      {scope.workspaceId
                        ? t("hostIdentity.workspace", {
                            id: scope.workspaceId,
                          })
                        : t("hostIdentity.allWorkspaces")}
                      {scope.executionHostId && (
                        <>
                          {" "}
                          ·{" "}
                          {t("hostIdentity.executionHost", {
                            id: scope.executionHostId,
                          })}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
              <SettingsRow label={null}>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async (mark) =>
                      accept(mark, await resumeIdentity()),
                    )
                  }
                >
                  {t("hostIdentity.restore")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async (mark) => {
                      await logoutIdentity();
                      await accept(mark, null);
                      if (live(mark)) setNotice("hostIdentity.loggedOut");
                    })
                  }
                >
                  {t("hostIdentity.logout")}
                </Button>
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      )}
    </section>
  );
}
