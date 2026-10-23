import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CredentialEntry, CredentialKind } from "@armadra/shared";
import { toast } from "@/ui/toast";

import { useT } from "@/app/preferences-store";
import { agentLabel } from "@/agent/launch";
import { CREDENTIALS_QUERY_KEY, credentialsApi } from "@/api/credentials";
import { pinLocal } from "@/api/source";
import { lk } from "../local-key";

/** 设置页管的是本机的节点凭据。 */
const localCredentials = pinLocal(credentialsApi);
const LOCAL_CREDENTIALS_KEY = lk("credentials");
import { Button } from "@/ui/button";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { IconButton } from "@/ui/icon-button";
import { StatusPill } from "@/ui/status-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsLoadable } from "../SettingsLoadable";
import { SettingsRow } from "../SettingsRow";

/**
 * 设置 → Agent 的「节点凭据」区块（契约 §20.2）。
 *
 * 每行只有名字与「Agent · 种类」；值写进去之后不再出现。未启用的种类在新建
 * 表单里灰掉并标「待实测」（CLI 协作 §7.4 T4–T7）。主机不能存凭据时整块只剩
 * 一句原因。
 */
export function AgentCredentials() {
  const t = useT();
  const credentials = useQuery({
    queryKey: LOCAL_CREDENTIALS_KEY,
    queryFn: ({ signal }) => localCredentials.list(signal),
    staleTime: 60_000,
    retry: false,
  });
  if (!credentials.data && !credentials.isLoading) return null;
  return (
    <SettingsLoadable
      grouped
      title={t("credentials.title")}
      loading={!credentials.data}
      rows={2}
      control="switch"
    >
      {credentials.data ? (
        <AgentCredentialsGroup data={credentials.data} />
      ) : null}
    </SettingsLoadable>
  );
}

function AgentCredentialsGroup({
  data,
}: {
  data: Awaited<ReturnType<typeof localCredentials.list>>;
}) {
  const t = useT();
  const client = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<CredentialEntry | null>(null);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: LOCAL_CREDENTIALS_KEY }),
      // 当前源就是本机时，节点上的凭据徽标读的是这份。
      client.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY }),
    ]);
  const remove = useMutation({
    mutationFn: (ref: string) => localCredentials.remove(ref),
    onSuccess: () => {
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  if (!data.available) {
    return (
      <SettingsGroup title={t("credentials.title")}>
        <SettingsRow
          label={t(
            `credentials.unavailable.${data.reason ?? "credential_unsupported_here"}`,
          )}
        />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup title={t("credentials.title")}>
      {data.entries.map((entry) => (
        <SettingsRow key={entry.ref} label={entry.label}>
          <span className="flex items-center gap-2 text-caption text-muted-foreground">
            {!entry.isSet && (
              <StatusPill tone="paused" label={t("credentials.notSet")} />
            )}
            {agentLabel(entry.providerId)} · {entry.kind}
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  label={t("credentials.delete")}
                  onClick={() => setRemoving(entry)}
                >
                  <Trash2 />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>{t("credentials.delete")}</TooltipContent>
            </Tooltip>
          </span>
        </SettingsRow>
      ))}
      {data.entries.length === 0 && (
        <SettingsRow label={t("credentials.empty")} />
      )}
      <SettingsRow label={null}>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus />
          {t("credentials.add")}
        </Button>
      </SettingsRow>

      <CredentialDialog
        open={adding}
        kinds={data.kinds}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          void refresh();
        }}
      />

      <ResponsiveAlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("credentials.deleteConfirm", { label: removing?.label ?? "" })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("credentials.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={() => {
                if (removing) remove.mutate(removing.ref);
                setRemoving(null);
              }}
            >
              {t("credentials.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </SettingsGroup>
  );
}

function kindKey(kind: CredentialKind): string {
  return `${kind.providerId}/${kind.kind}`;
}

function CredentialDialog({
  open,
  kinds,
  onClose,
  onSaved,
}: {
  open: boolean;
  kinds: readonly CredentialKind[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const firstEnabled = kinds.find((kind) => kind.enabled);
  const [choice, setChoice] = React.useState(
    firstEnabled ? kindKey(firstEnabled) : "",
  );
  const [label, setLabel] = React.useState("");
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    if (!open) {
      setLabel("");
      setValue("");
    }
  }, [open]);
  const selected = kinds.find((kind) => kindKey(kind) === choice);
  const create = useMutation({
    mutationFn: () =>
      localCredentials.create({
        providerId: selected?.providerId ?? "",
        kind: selected?.kind ?? "",
        label: label.trim(),
        value: value.trim(),
      }),
    onSuccess: onSaved,
    onError: (error) => toast.error(error.message),
  });
  const ready =
    selected?.enabled === true &&
    label.trim() !== "" &&
    value.trim() !== "" &&
    !create.isPending;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[420px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("credentials.add")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) create.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-kind">{t("credentials.kind")}</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id="credential-kind" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {kinds.map((kind) => (
                  <SelectItem
                    key={kindKey(kind)}
                    value={kindKey(kind)}
                    disabled={!kind.enabled}
                  >
                    {agentLabel(kind.providerId)} · {kind.kind}
                    {!kind.enabled && (
                      <span className="ml-2 text-muted-foreground">
                        {t("credentials.pending")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-label">{t("credentials.label")}</Label>
            <Input
              id="credential-label"
              className="text-meta"
              maxLength={200}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-value">{t("credentials.value")}</Label>
            <Input
              id="credential-value"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="text-meta"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("credentials.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!ready}>
              {t("credentials.save")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
