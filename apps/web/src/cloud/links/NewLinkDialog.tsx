import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";

import { SHARE_LINK_MAX_USES } from "@armadra/shared";
import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { toast } from "@/ui/toast";
import { CloudConsoleError, describeFailure } from "../api/errors";
import { useHostChannel } from "../host-channel-context";
import { FixCommand } from "../host/FixCommand";
import { hostCanvasHref } from "../hosts/HostActions";
import { endorseCode } from "../trust/endorser";
import { keyOfSpace, type CloudSpace } from "../space";
import { LINK_ROLES, createHostLink, type LinkRole } from "./host-link";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 有效期（天）：缺省 7。 */
const DAYS = ["1", "7", "30"] as const;

/** 失败分到哪种提示：本浏览器不受信、主机没登录云、主机不认你作主人、其余按码。 */
type Failure =
  | { kind: "untrusted" }
  | { kind: "signIn" }
  | { kind: "notOwner" }
  | { kind: "other"; code: string };

function failureOf(error: unknown): Failure {
  const code = endorseCode(error) ?? "e2e_device_unavailable";
  if (code === "device_untrusted") return { kind: "untrusted" };
  if (code === "cloud_not_registered" || code === "source_unauthorized")
    return { kind: "signIn" };
  if (code === "forbidden") return { kind: "notOwner" };
  return { kind: "other", code };
}

/**
 * 「新建链接」（设计 saas-host-open §4.3，B5；只给主人）：整台主机、权限（只读缺省）、有效期、次数上限、
 * 备注 → 经端到端通道请主机建链接 → 结果对话框给整条链接与「复制链接」。整条链接只在组件状态里，
 * 关掉就没了，不进地址、日志与查询缓存。
 */
export function NewLinkDialog({
  space,
  host,
  onClose,
}: {
  space: CloudSpace;
  host: { readonly sourceId: string; readonly name: string };
  onClose: () => void;
}) {
  const t = useT();
  const channel = useHostChannel();
  const client = useQueryClient();
  const [role, setRole] = React.useState<LinkRole>("viewer");
  const [days, setDays] = React.useState<string>("7");
  const [maxUses, setMaxUses] = React.useState(String(SHARE_LINK_MAX_USES));
  const [label, setLabel] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [url, setUrl] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const ids = { role: React.useId(), uses: React.useId(), note: React.useId() };
  const uses = Number(maxUses);
  const validUses =
    Number.isInteger(uses) && uses >= 1 && uses <= SHARE_LINK_MAX_USES;
  const issuer = window.location.origin;

  const submit = async () => {
    if (channel === null || pending || !validUses) return;
    setPending(true);
    setFailure(null);
    try {
      const created = await createHostLink(channel, issuer, host.sourceId, {
        role,
        ttlMs: Number(days) * DAY_MS,
        maxUses: uses,
        label,
      });
      if (!mounted.current) return;
      setUrl(created);
      void client.invalidateQueries({
        queryKey: ["cloud", keyOfSpace(space), "links"],
      });
    } catch (error) {
      if (mounted.current) setFailure(failureOf(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const copy = async () => {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("cloud.hosts.copied"));
    } catch {
      toast.error(t("error.internal"));
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t(url === null ? "cloud.links.new" : "cloud.links.created")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {url !== null ? (
          <>
            <InputGroup data-slot="new-link-url">
              <InputGroupInput
                readOnly
                aria-label={t("cloud.links.url")}
                value={url}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="xs" onClick={() => void copy()}>
                  <Copy aria-hidden data-icon="inline-start" />
                  {t("cloud.links.copy")}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <ResponsiveDialogFooter>
              <Button type="button" onClick={onClose}>
                {t("cloud.links.done")}
              </Button>
            </ResponsiveDialogFooter>
          </>
        ) : (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor={ids.role}>
                  {t("cloud.hosts.access")}
                </FieldLabel>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value as LinkRole)}
                >
                  <SelectTrigger id={ids.role}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[var(--z-dialog)]">
                    {LINK_ROLES.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {t(`workspaceGroups.role.${entry}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>{t("cloud.links.validity")}</FieldLabel>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger aria-label={t("cloud.links.validity")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[var(--z-dialog)]">
                    {DAYS.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {t(`remote.invite.day${entry}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field data-invalid={validUses ? undefined : true}>
                <FieldLabel htmlFor={ids.uses}>
                  {t("cloud.links.maxUses")}
                </FieldLabel>
                <Input
                  id={ids.uses}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={SHARE_LINK_MAX_USES}
                  value={maxUses}
                  aria-invalid={validUses ? undefined : true}
                  className="tabular-nums"
                  onChange={(event) => setMaxUses(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.note}>
                  {t("cloud.links.note")}
                </FieldLabel>
                <Input
                  id={ids.note}
                  value={label}
                  maxLength={128}
                  autoComplete="off"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>
            </FieldGroup>
            {failure !== null ? (
              <FailureNotice failure={failure} host={host} issuer={issuer} />
            ) : null}
            <ResponsiveDialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("cloud.common.cancel")}
              </Button>
              <Button type="submit" loading={pending} disabled={!validUses}>
                {t("cloud.links.create")}
              </Button>
            </ResponsiveDialogFooter>
          </form>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function FailureNotice({
  failure,
  host,
  issuer,
}: {
  failure: Failure;
  host: { readonly sourceId: string };
  issuer: string;
}) {
  const t = useT();
  if (failure.kind === "untrusted")
    return (
      <Alert
        data-slot="new-link-untrusted"
        className="flex flex-wrap items-center gap-2"
      >
        <AlertTitle className="min-w-0 flex-1">
          {t("cloud.links.openFirst")}
        </AlertTitle>
        <Button asChild size="sm" variant="secondary">
          <a
            href={hostCanvasHref(host.sourceId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("cloud.links.openHost")}
          </a>
        </Button>
      </Alert>
    );
  if (failure.kind === "signIn" || failure.kind === "notOwner")
    return (
      <Alert variant="destructive" data-slot={`new-link-${failure.kind}`}>
        <AlertTitle>
          {t(
            failure.kind === "signIn"
              ? "cloud.links.hostSignedOut"
              : "cloud.host.memberNotOwner",
          )}
        </AlertTitle>
        <AlertDescription className="mt-1 text-foreground">
          <FixCommand issuer={issuer} />
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert variant="destructive" data-slot="new-link-failed">
      <AlertTitle>
        {describeFailure(new CloudConsoleError(failure.code, 0))}
      </AlertTitle>
    </Alert>
  );
}
