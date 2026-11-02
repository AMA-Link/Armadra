import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";

import {
  onIdentitySessionChange,
  permits,
  renewCsrf,
  resumeIdentity,
  type IdentitySession,
} from "../../../../api/identity";
import {
  clearLockout,
  confirmTotp,
  disableMfa,
  enrollTotp,
  listLockouts,
  listMembers,
  listPasskeys,
  mfaStatus,
  oauthBindings,
  oauthProviders,
  passkeyLabel,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  regenerateRecoveryCodes,
  clearOAuthSecret,
  removeOAuthBinding,
  setOAuthSecret,
  removePasskey,
  renamePasskey,
  startOAuth,
  takeOAuthFragment,
  type OAuthOutcome,
} from "../../../../api/security";
import { RUNTIME_VIA_SERVER_SHELL } from "../../../../api/request";
import { isNativeApp } from "../../../../mobile/native-bridge";
import { useT } from "../../../../app/preferences-store";
import { SignIn } from "../../../../session/SignIn";
import { securityFailure } from "../../../../session/sign-in-errors";
import {
  createCredential,
  webauthnAvailable,
  webauthnCancelled,
} from "../../../../session/webauthn";
import { PageCaGuide } from "../gateway/CaInstallGuide";
import {
  GatewayDevicesSection,
  type GatewayIdentity,
} from "../gateway/GatewaySection";
import { AuditLog } from "./AuditLog";
import { DeviceSignIn } from "./DeviceSignIn";
import { E2eDevices } from "./E2eDevices";
import { LoginSessions } from "./LoginSessions";
import { MfaSetup, type MfaStage } from "./MfaSetup";
import { OAuthBindings, OAuthProviders } from "./OAuthBindings";
import { PasskeyList } from "./PasskeyList";
import { LockoutList } from "./SessionList";
import { Skeleton } from "@/ui/skeleton";
import { SettingsPageHeader } from "../../SettingsPageHeader";

const KEY = ["identity", "security"] as const;

/**
 * 设置 → 账号与设备（#708：原「设备与会话」与「账号与安全」两页合成这一页）。
 *
 * 所有角色都进得来（作用范围 account）：每个人都管自己的登录与设备。自上而下：
 * 设备登录（这台设备的身份会话、配对）· 两步验证（策略要求而没开时排第一）· 通行密钥 ·
 * 第三方账号 · 已配对设备 · 经中转的设备 · 登录会话；owner 另有登录提供方、锁定的账号
 * 与审计。还没登录时登录方式那几块换成登录表单。
 *
 * OAuth 回调（`#oauth=`，契约 §18.5）由 `use-link-fragments` 打开到这一页，
 * 这里取走片段：登录成功换会话，`mfa` 接第二步，`bound` 提示已绑定，`error`
 * 显示原因。配对链接（`#pair=`）由「设备登录」取走；配对、登出之后会话变了，
 * 这一页跟着重新取一次。
 */
export function SecurityPage() {
  const t = useT();
  const client = useQueryClient();
  const [session, setSession] = React.useState<
    IdentitySession | null | undefined
  >(undefined);
  const [outcome] = React.useState<OAuthOutcome | null>(() =>
    takeOAuthFragment(),
  );
  // 设备表只有一份；「设备登录」报上这台设备是谁、能不能管理。撤销了自己就
  // 让「设备登录」重新取一次会话（得到的是已退出）。
  const [identity, setIdentity] = React.useState<GatewayIdentity | null>(null);
  const [identityEpoch, setIdentityEpoch] = React.useState(0);
  const onDeviceSession = React.useCallback((value: IdentitySession | null) => {
    setIdentity(
      value
        ? {
            deviceId: value.device.deviceId,
            canManage: value.scopes.some(
              (scope) => scope.permission === "identity:manage",
            ),
          }
        : null,
    );
  }, []);

  React.useEffect(() => {
    let live = true;
    const signedIn =
      outcome?.result === "signedIn" || outcome?.result === "signedUp";
    void (async () => {
      const resumed = await resumeIdentity();
      // 回调发的是 Cookie；CSRF 只在内存里，换一枚并让各处重取。
      if (resumed && signedIn && RUNTIME_VIA_SERVER_SHELL) {
        await renewCsrf().catch(() => "");
      }
      return resumed;
    })().then(
      (value) => {
        if (!live) return;
        setSession(value);
        if (value && outcome?.result === "bound") {
          toast.success(t("security.oauth.linked"));
        } else if (value && outcome?.result === "error") {
          toast.error(oauthError(outcome.code, t));
        }
      },
      () => {
        if (live) setSession(null);
      },
    );
    // 配对、登出、换人之后重取；续期（`rotated`）还是同一条会话。
    const off = onIdentitySessionChange((change) => {
      if (change === "rotated") return;
      void resumeIdentity().then(
        (value) => {
          if (live) setSession(value);
        },
        () => {
          if (live) setSession(null);
        },
      );
    });
    return () => {
      live = false;
      off();
    };
    // 片段只在挂载时读一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 没有会话时用哪一种登录：服务器壳、原生 App 与 OAuth 回调走登录表单（「设备登录」
  // 只留状态，地址栏的配对票照样取走）；其余只有「设备登录」。一页只有一张表单。
  const signInForm =
    session === null &&
    (outcome !== null || RUNTIME_VIA_SERVER_SHELL || isNativeApp());

  const devices = (
    <>
      <GatewayDevicesSection
        identity={identity}
        onCurrentRevoked={() => setIdentityEpoch((epoch) => epoch + 1)}
      />
      <E2eDevices />
      <LoginSessions />
    </>
  );

  return (
    <>
      <SettingsPageHeader />
      <PageCaGuide />
      <DeviceSignIn
        epoch={identityEpoch}
        onSession={onDeviceSession}
        // 会话还在加载时不给配对票表单：结果回来后可能是登录表单，先闪一下再换很扎眼。
        ticketForm={session !== undefined && !signInForm}
      />
      {session === undefined ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : session === null ? (
        <>
          {signInForm && (
            <SignIn
              initial={
                outcome?.result === "mfa" && outcome.challengeId
                  ? { challengeId: outcome.challengeId }
                  : outcome?.result === "error"
                    ? { error: oauthError(outcome.code, t) }
                    : undefined
              }
              onSignedIn={(next) => {
                setSession(next);
                void client.invalidateQueries();
              }}
            />
          )}
          {devices}
        </>
      ) : (
        <SecuritySettings session={session}>{devices}</SecuritySettings>
      )}
    </>
  );
}

function oauthError(code: string, t: ReturnType<typeof useT>): string {
  const key = `auth.error.${code}`;
  const text = t(key);
  return text === key ? t("auth.error.failed") : text;
}

/**
 * 登录方式（两步验证、通行密钥、第三方账号）· `children`（设备与会话）· owner 的
 * 登录提供方、锁定与审计。
 */
function SecuritySettings({
  session,
  children,
}: {
  session: IdentitySession;
  children: React.ReactNode;
}) {
  const t = useT();
  const client = useQueryClient();
  const manage = permits(session, "identity:manage");
  const fail = React.useCallback(
    (error: unknown) => toast.error(securityFailure(error, t)),
    [t],
  );
  const refresh = React.useCallback(
    (part: string) => client.invalidateQueries({ queryKey: [...KEY, part] }),
    [client],
  );

  const mfa = useQuery({ queryKey: [...KEY, "mfa"], queryFn: mfaStatus });
  const passkeys = useQuery({
    queryKey: [...KEY, "passkeys"],
    queryFn: listPasskeys,
  });
  const providers = useQuery({
    queryKey: [...KEY, "providers"],
    queryFn: () => oauthProviders(false),
  });
  const bindings = useQuery({
    queryKey: [...KEY, "bindings"],
    queryFn: oauthBindings,
  });
  const lockouts = useQuery({
    queryKey: [...KEY, "lockouts"],
    queryFn: listLockouts,
    enabled: manage,
  });
  const members = useQuery({
    queryKey: [...KEY, "members"],
    queryFn: listMembers,
    enabled: manage,
  });
  const names = React.useMemo(
    () =>
      new Map(
        (members.data ?? []).map((member) => [
          member.principalId,
          member.displayName,
        ]),
      ),
    [members.data],
  );

  /* ------------------------------ 两步验证 ------------------------------ */
  const [stage, setStage] = React.useState<MfaStage>({ kind: "idle" });
  const [mfaBusy, setMfaBusy] = React.useState(false);
  const [mfaError, setMfaError] = React.useState("");
  const mfaStep = (work: () => Promise<void>) => {
    setMfaBusy(true);
    setMfaError("");
    work()
      .catch((error: unknown) => setMfaError(securityFailure(error, t)))
      .finally(() => setMfaBusy(false));
  };

  /* ------------------------------ 通行密钥 ------------------------------ */
  const [passkeyBusy, setPasskeyBusy] = React.useState<string | null>(null);
  const addPasskey = () => {
    setPasskeyBusy("add");
    const label = passkeyLabel();
    void (async () => {
      const begun = await passkeyRegisterOptions(label);
      const response = await createCredential(begun.options);
      await passkeyRegisterVerify(begun.challengeId, response, label);
    })()
      .then(
        () => toast.success(t("security.passkeys.added")),
        (error: unknown) => {
          if (!webauthnCancelled(error)) fail(error);
        },
      )
      .finally(() => {
        setPasskeyBusy(null);
        void refresh("passkeys");
      });
  };

  /* ------------------------------- 其余动作 ------------------------------- */
  const [oauthBusy, setOauthBusy] = React.useState<string | null>(null);
  const [lockBusy, setLockBusy] = React.useState<string | null>(null);
  const [providerBusy, setProviderBusy] = React.useState<string | null>(null);
  const act = (
    setBusy: (value: string | null) => void,
    id: string,
    work: () => Promise<unknown>,
    part: string,
  ) => {
    setBusy(id);
    work()
      .catch(fail)
      .finally(() => {
        setBusy(null);
        void refresh(part);
      });
  };

  const mfaFirst = mfa.data?.required && !mfa.data.enrolled;
  const mfaBlock = (
    <MfaSetup
      status={mfa.data}
      stage={stage}
      busy={mfaBusy}
      error={mfaError}
      onEnable={() =>
        mfaStep(async () => {
          setStage({ kind: "enrolling", enrollment: await enrollTotp() });
        })
      }
      onConfirm={(code) =>
        mfaStep(async () => {
          const codes = await confirmTotp(code);
          setStage({ kind: "codes", codes });
          await refresh("mfa");
        })
      }
      onRequest={(purpose) => {
        setMfaError("");
        setStage({ kind: "verify", purpose });
      }}
      onVerify={(purpose, code) =>
        mfaStep(async () => {
          if (purpose === "disable") {
            await disableMfa(code);
            setStage({ kind: "idle" });
          } else {
            setStage({
              kind: "codes",
              codes: await regenerateRecoveryCodes(code),
            });
          }
          await refresh("mfa");
        })
      }
      onCancel={() => {
        setMfaError("");
        setStage({ kind: "idle" });
      }}
    />
  );

  return (
    <>
      {mfaFirst && mfaBlock}
      <PasskeyList
        list={passkeys.data}
        loading={passkeys.isLoading}
        supported={webauthnAvailable()}
        busy={passkeyBusy}
        onAdd={addPasskey}
        onRemove={(passkey) =>
          act(
            setPasskeyBusy,
            passkey.credentialId,
            () => removePasskey(passkey.credentialId),
            "passkeys",
          )
        }
        onRename={(passkey, label) =>
          renamePasskey(passkey.credentialId, label).then(
            async () => {
              await refresh("passkeys");
              toast.success(t("security.passkeys.renamed"));
              return true;
            },
            (error: unknown) => {
              fail(error);
              return false;
            },
          )
        }
      />
      {!mfaFirst && mfaBlock}
      <OAuthBindings
        bindings={bindings.data}
        loading={bindings.isLoading}
        providers={
          providers.data?.configured
            ? providers.data.providers.filter(
                (provider) => provider.usable !== false,
              )
            : []
        }
        busy={oauthBusy}
        onBind={(provider) => {
          setOauthBusy(provider.id);
          startOAuth(provider.id, "bind").catch((error: unknown) => {
            setOauthBusy(null);
            fail(error);
          });
        }}
        onUnbind={(binding) =>
          act(
            setOauthBusy,
            binding.credentialId,
            () => removeOAuthBinding(binding.credentialId),
            "bindings",
          )
        }
      />
      {children}
      {manage && (
        <OAuthProviders
          providers={providers.data?.providers ?? []}
          busy={providerBusy}
          onSetSecret={(provider, secret) =>
            act(
              setProviderBusy,
              provider.id,
              () => setOAuthSecret(provider.id, secret),
              "providers",
            )
          }
          onClearSecret={(provider) =>
            act(
              setProviderBusy,
              provider.id,
              () => clearOAuthSecret(provider.id),
              "providers",
            )
          }
        />
      )}
      {manage && (
        <LockoutList
          lockouts={lockouts.data}
          names={names}
          busy={lockBusy}
          onUnlock={(lockout) =>
            act(
              setLockBusy,
              lockout.principalId,
              () => clearLockout(lockout.principalId),
              "lockouts",
            )
          }
        />
      )}
      {manage && (
        <AuditLog
          members={(members.data ?? []).map((member) => ({
            principalId: member.principalId,
            displayName: member.displayName,
          }))}
        />
      )}
    </>
  );
}
