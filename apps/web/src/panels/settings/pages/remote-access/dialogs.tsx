import { Loadable } from "@/loading/Loadable";
import { SkeletonList } from "@/ui/skeletons";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";

import {
  type RemoteService,
  type RemoteSourceSummary,
  addDirectSource,
  addPersonalRelay,
  isPairLink,
  mountRemoteSource,
  mountSourceByLink,
  remoteSources,
} from "../../../../api/remote-services";
import { useT } from "../../../../app/preferences-store";
import { ChallengeSheet } from "../../../../mobile/ChallengeSheet";
import { groupFingerprint } from "../gateway/PairingCard";
import { checkAddress } from "../remote-address";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import { EmptyState } from "@/ui/state";

/*
 * 远程访问页的对话框：登录中转账号、配对另一台我的电脑（链接或地址 + 配对码）、
 * 用链接加入、从中转添加。首次见到的对端先核对证书指纹。
 */

/* ------------------------------ 指纹核对 ------------------------------- */

export function FingerprintCheck({ fingerprint }: { fingerprint: string }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-meta text-muted-foreground">
        {t("remote.fingerprint")}
      </span>
      <p
        data-slot="fingerprint"
        className="font-mono text-meta leading-5 select-text"
      >
        {/* 只在冒号后折行：一组两位不被拆开，好逐组对照。 */}
        {groupFingerprint(fingerprint)
          .split(":")
          .map((pair, index) => (
            <React.Fragment key={index}>
              {index > 0 && (
                <>
                  :<wbr />
                </>
              )}
              {pair}
            </React.Fragment>
          ))}
      </p>
    </div>
  );
}

/* ------------------------------ 个人中转 ------------------------------- */

export interface RelayDraft {
  readonly issuer: string;
  readonly account: string;
  /** 已知的指纹（重新登录）；新加的是空串。 */
  readonly fingerprint: string;
}

/**
 * 添加个人中转，或对已有的一行重新登录（地址与指纹不再改）。首次没有指纹时
 * core 答出对端的指纹，换成核对这一步；人确认后带着指纹再登录一次。
 */
export function AddRelayDialog({
  draft,
  onClose,
  onDone,
}: {
  draft: RelayDraft | null;
  onClose(): void;
  onDone(): void;
}) {
  const t = useT();
  const relogin = draft !== null && draft.issuer !== "";
  const [issuer, setIssuer] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirming, setConfirming] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // 远程服务要求人机验证（契约 §62）：升起挑战面板，令牌到了带着刚填的内容再提交。
  const [challenge, setChallenge] = React.useState<{
    readonly siteKey: string;
    readonly issuer: string;
    readonly fingerprint: string;
  } | null>(null);

  React.useEffect(() => {
    if (draft === null) return;
    setChallenge(null);
    setIssuer(draft.issuer);
    setAccount(draft.account);
    setPassword("");
    setConfirming("");
    setError("");
  }, [draft]);

  async function submit(fingerprint: string, challengeToken?: string) {
    if (busy) return;
    const checked = checkAddress(issuer);
    if (!checked.ok) {
      setError(t(checked.error));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await addPersonalRelay({
        issuer: checked.address,
        account,
        password,
        ...(fingerprint ? { fingerprint } : {}),
        ...(challengeToken ? { challengeToken } : {}),
      });
      if (answer.kind === "confirm") {
        setConfirming(answer.fingerprint);
        return;
      }
      if (answer.kind === "challenge") {
        setChallenge({
          siteKey: answer.siteKey,
          issuer: checked.address,
          fingerprint,
        });
        return;
      }
      setPassword("");
      onDone();
    } catch (failure) {
      setConfirming("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    issuer.trim() !== "" && account.trim() !== "" && password !== "";

  return (
    <ResponsiveDialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {confirming
              ? t("remote.fingerprint.confirm")
              : relogin
                ? t("remote.signIn")
                : t("remote.add")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirming) void submit(confirming);
            else if (ready) void submit(draft?.fingerprint ?? "");
          }}
        >
          {confirming ? (
            <>
              <p className="text-body break-all">{issuer.trim()}</p>
              <FingerprintCheck fingerprint={confirming} />
            </>
          ) : (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="remote-issuer">
                  {t("remote.field.issuer")}
                </FieldLabel>
                <Input
                  id="remote-issuer"
                  inputMode="url"
                  autoComplete="url"
                  spellCheck={false}
                  placeholder="https://relay.example.com"
                  readOnly={relogin}
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="remote-account">
                  {t("remote.field.account")}
                </FieldLabel>
                <Input
                  id="remote-account"
                  autoComplete="username"
                  spellCheck={false}
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                />
              </Field>
              <Field className="gap-1.5" data-invalid={error !== ""}>
                <FieldLabel htmlFor="remote-password">
                  {t("remote.field.password")}
                </FieldLabel>
                <Input
                  id="remote-password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={error !== ""}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => (confirming ? setConfirming("") : onClose())}
            >
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!confirming && !ready)}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {confirming ? t("remote.fingerprint.trust") : t("remote.signIn")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
        {challenge !== null && (
          <ChallengeSheet
            open
            issuer={challenge.issuer}
            siteKey={challenge.siteKey}
            onCancel={() => setChallenge(null)}
            onToken={(token) => {
              const { fingerprint } = challenge;
              setChallenge(null);
              void submit(fingerprint, token);
            }}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/* ------------------------------ 自托管直连 ----------------------------- */

export function AddDirectDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const t = useT();
  const [address, setAddress] = React.useState("");
  const [code, setCode] = React.useState("");
  const [confirming, setConfirming] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const link = isPairLink(address);

  React.useEffect(() => {
    if (!open) return;
    setAddress("");
    setCode("");
    setConfirming("");
    setError("");
  }, [open]);

  async function submit(fingerprint: string) {
    if (busy) return;
    const checked = link ? null : checkAddress(address);
    if (checked !== null && !checked.ok) {
      setError(t(checked.error));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const answer = await addDirectSource(
        link
          ? { pairLink: address, ...(fingerprint ? { fingerprint } : {}) }
          : {
              origin: checked?.ok ? checked.address : address,
              code,
              ...(fingerprint ? { fingerprint } : {}),
            },
      );
      if (answer.kind === "confirm") {
        setConfirming(answer.fingerprint);
        return;
      }
      onDone();
    } catch (failure) {
      setConfirming("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready = address.trim() !== "" && (link || code.trim() !== "");

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {confirming
              ? t("remote.fingerprint.confirm")
              : t("remote.pairMine")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirming) void submit(confirming);
            else if (ready) void submit("");
          }}
        >
          {confirming ? (
            <>
              <p className="text-body break-all">{address.trim()}</p>
              <FingerprintCheck fingerprint={confirming} />
            </>
          ) : (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="direct-address">
                  {t("remote.direct.address")}
                </FieldLabel>
                <Input
                  id="direct-address"
                  inputMode="url"
                  spellCheck={false}
                  placeholder="https://192.168.1.20:8443"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </Field>
              {!link && (
                <Field className="gap-1.5" data-invalid={error !== ""}>
                  <FieldLabel htmlFor="direct-code">
                    {t("remote.direct.code")}
                  </FieldLabel>
                  <Input
                    id="direct-code"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    className="font-mono tracking-[0.08em]"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </Field>
              )}
            </FieldGroup>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => (confirming ? setConfirming("") : onClose())}
            >
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!confirming && !ready)}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {confirming
                ? t("remote.fingerprint.trust")
                : t("remote.direct.connect")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/* ----------------------------- 通过链接加入 ----------------------------- */

/**
 * 粘贴分享链接（网页链接或 `armadra://join`）挂载：本机 core 接受链接、经中继
 * 登录、存凭据（契约 §33.7）。签发方第一次见时先核对证书指纹。`initial` 为
 * `null` 是关着；空串是空白打开；别的是深链预填的链接。
 */
export function JoinLinkDialog({
  initial,
  onClose,
  onJoined,
}: {
  initial: string | null;
  onClose(): void;
  onJoined(sourceId: string): void;
}) {
  const t = useT();
  const [url, setUrl] = React.useState("");
  const [confirming, setConfirming] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (initial === null) return;
    setUrl(initial);
    setConfirming("");
    setError("");
  }, [initial]);

  async function submit(fingerprint: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const answer = await mountSourceByLink({
        url,
        ...(fingerprint ? { fingerprint } : {}),
      });
      if (answer.kind === "confirm") {
        setConfirming(answer.fingerprint);
        return;
      }
      setUrl("");
      onJoined(answer.value.sourceId);
    } catch (failure) {
      setConfirming("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready = url.trim() !== "";
  let host = "";
  try {
    host = new URL(url.trim()).host;
  } catch {
    host = "";
  }

  return (
    <ResponsiveDialog
      open={initial !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {confirming ? t("remote.fingerprint.confirm") : t("links.join")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirming) void submit(confirming);
            else if (ready) void submit("");
          }}
        >
          {confirming ? (
            <>
              {host && <p className="text-body break-all">{host}</p>}
              <FingerprintCheck fingerprint={confirming} />
            </>
          ) : (
            <FieldGroup className="gap-3">
              <Field className="gap-1.5" data-invalid={error !== ""}>
                <FieldLabel htmlFor="join-link">{t("links.field")}</FieldLabel>
                <Input
                  id="join-link"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error !== ""}
                  placeholder="https://relay.example.com/j/…"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {error && <FieldError>{error}</FieldError>}
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => (confirming ? setConfirming("") : onClose())}
            >
              {t("remote.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (!confirming && !ready)}>
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {confirming ? t("remote.fingerprint.trust") : t("links.action")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/* --------------------------- 从远程服务挂载 ---------------------------- */

export function MountDialog({
  open,
  remotes,
  onClose,
  onMounted,
}: {
  open: boolean;
  remotes: readonly RemoteService[];
  onClose(): void;
  onMounted(): void;
}) {
  const t = useT();
  const client = useQueryClient();
  const [serviceId, setServiceId] = React.useState("");
  const chosen =
    remotes.find((remote) => remote.serviceId === serviceId) ?? remotes[0];
  const listing = useQuery({
    queryKey: ["sources", "remote", chosen?.serviceId ?? ""],
    queryFn: () => remoteSources(chosen?.serviceId ?? ""),
    enabled: open && chosen !== undefined,
    retry: false,
  });
  const mount = useMutation({
    mutationFn: (source: RemoteSourceSummary) =>
      mountRemoteSource(chosen?.serviceId ?? "", source.sourceId),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["sources", "remote", chosen?.serviceId ?? ""],
      });
      onMounted();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const rows = listing.data?.sources ?? [];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[440px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("remote.mount")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          {remotes.length > 1 && (
            <Select
              value={chosen?.serviceId ?? ""}
              onValueChange={setServiceId}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("remote.services")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {remotes.map((remote) => (
                  <SelectItem key={remote.serviceId} value={remote.serviceId}>
                    {remote.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Loadable
            loading={listing.isPending}
            skeleton={
              <SkeletonList rows={3} label={t("state.loading")} size="tall" />
            }
          >
            {listing.isError ? (
              <p role="alert" className="text-body text-destructive">
                {listing.error.message}
              </p>
            ) : rows.length === 0 ? (
              <EmptyState inline title={t("remote.mount.empty")} />
            ) : (
              <ul className="flex flex-col divide-y divide-border-soft">
                {rows.map((source) => (
                  <li
                    key={source.sourceId}
                    className="flex min-w-0 items-center justify-between gap-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-body">{source.name}</span>
                      <StatusPill
                        tone={source.online ? "done" : "idle"}
                        label={t(
                          source.online
                            ? "remote.status.ready"
                            : "remote.status.offline",
                        )}
                      />
                    </span>
                    {source.mounted ? (
                      <Badge variant="secondary" size="sm">
                        {t("remote.mounted")}
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={mount.isPending || !source.online}
                        onClick={() => mount.mutate(source)}
                      >
                        {t("remote.mount.action")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
