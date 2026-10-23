import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import {
  AGENT_IDS,
  customAgentSchema,
  type BuiltinAgentId,
  type AgentCapability,
  type CustomAgent,
} from "@armadra/shared";
import { toast } from "@/ui/toast";
import { CapabilityInheritance } from "@/agent/CapabilityInheritance";

import { agentLabel } from "@/agent/launch";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsLoadable } from "../SettingsLoadable";
import { SettingsPageHeader } from "../SettingsPageHeader";
import { SettingsRow } from "../SettingsRow";
import { SettingsTableCard } from "../SettingsTableCard";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { IconButton } from "@/ui/icon-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/**
 * 设置 → 自定义 Agent（§2.1）。
 *
 * 一条一行，点一行或「添加」推入同一右栏里的子页（名称、命令、参数、环境变量、
 * 基础 Agent 与能力继承），删除放在子页页尾。
 */
export function CustomAgentsPage() {
  const t = useT();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings({ scope: "local" });
  const custom = React.useMemo(
    () => settings.data?.agents?.custom ?? [],
    [settings.data],
  );

  if (subpage.current?.startsWith("agent:")) {
    return (
      <CustomAgentForm
        reference={subpage.current.slice("agent:".length)}
        custom={custom}
        disabled={!settings.data}
        onSubmit={(next) => {
          save.mutate({ agents: { custom: next } });
          subpage.close();
        }}
        onCancel={subpage.close}
      />
    );
  }

  const addCustom = (
    <Button
      size="sm"
      disabled={!settings.data}
      onClick={() => subpage.open("agent", "new")}
    >
      <Plus data-icon="inline-start" />
      {t("settings.customAgent.add")}
    </Button>
  );

  return (
    <>
      <SettingsPageHeader actions={custom.length > 0 ? addCustom : undefined} />
      <SettingsLoadable
        grouped
        loading={settings.isLoading}
        rows={2}
        control="switch"
      >
        <SettingsTableCard
          title={t("settings.section.customAgents")}
          empty={
            custom.length === 0
              ? {
                  title: t("settings.customAgent.empty"),
                  action: addCustom,
                }
              : null
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.customAgent.name")}</TableHead>
                <TableHead>{t("settings.customAgent.base")}</TableHead>
                <TableHead>{t("settings.customAgent.command")}</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">
                    {t("settings.customAgent.edit")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {custom.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="xs"
                      data-roving-item
                      className="-mx-1.5 max-w-full justify-start font-normal"
                      onClick={() => subpage.open("agent", agent.id)}
                    >
                      <span className="truncate">{agent.label}</span>
                    </Button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {agentLabel(agent.baseAgent)}
                  </TableCell>
                  <TableCell
                    className="max-w-[320px] truncate font-mono text-meta text-muted-foreground"
                    title={agent.launchCmd}
                  >
                    {agent.launchCmd}
                  </TableCell>
                  <TableCell className="text-end">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <IconButton
                          label={t("settings.customAgent.edit")}
                          onClick={() => subpage.open("agent", agent.id)}
                        >
                          <Pencil />
                        </IconButton>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t("settings.customAgent.edit")}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsTableCard>
      </SettingsLoadable>
    </>
  );
}

/* -------------------------------- 自定义 Agent ---------------------------- */

interface AgentForm {
  label: string;
  launchCmd: string;
  args: string;
  env: string;
  baseAgent: BuiltinAgentId;
  disabledCapabilities?: AgentCapability[];
}

const EMPTY_FORM: AgentForm = {
  label: "",
  launchCmd: "",
  args: "",
  env: "",
  baseAgent: "claude",
};

function toForm(agent: CustomAgent | undefined): AgentForm {
  if (!agent) return EMPTY_FORM;
  return {
    label: agent.label,
    launchCmd: agent.launchCmd,
    args: agent.args.join(" "),
    env: envToText(agent),
    baseAgent: agent.baseAgent,
    disabledCapabilities: agent.disabledCapabilities,
  };
}

/** `KEY=value` 一行一条。 */
function envToText(agent: CustomAgent): string {
  if (!agent.env) return "";
  return Object.entries(agent.env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    env[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return env;
}

/** 表单 → 自定义 Agent。校验用的是 shared 的 schema，和 Runtime 同一套规则。 */
export function parseAgentForm(
  form: AgentForm,
  id: string,
): CustomAgent | null {
  const args = form.args.trim().split(/\s+/).filter(Boolean);
  const env = parseEnvText(form.env);
  const parsed = customAgentSchema.safeParse({
    id,
    label: form.label.trim(),
    launchCmd: form.launchCmd.trim(),
    args,
    baseAgent: form.baseAgent,
    ...(form.disabledCapabilities
      ? { disabledCapabilities: form.disabledCapabilities }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function CustomAgentForm({
  reference,
  custom,
  disabled,
  onSubmit,
  onCancel,
}: {
  reference: string;
  custom: readonly CustomAgent[];
  disabled: boolean;
  onSubmit: (next: CustomAgent[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const agents = useAgentsQuery("local");
  const existing = custom.find((agent) => agent.id === reference);
  const [form, setForm] = React.useState<AgentForm>(() => toForm(existing));
  const [pendingDelete, setPendingDelete] = React.useState(false);
  // 探测跟着基础适配器走：能力受限于它借用的那个 CLI 的版本，而不是这份
  // 自定义配置自己填的启动程序名。
  const probe =
    agents.data?.find((entry) => entry.id === form.baseAgent)?.probe ?? null;

  const set = (key: keyof AgentForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const fields: Array<{ key: "label" | "launchCmd" | "args"; label: string }> =
    [
      { key: "label", label: t("settings.customAgent.name") },
      { key: "launchCmd", label: t("settings.customAgent.command") },
      { key: "args", label: t("settings.customAgent.args") },
    ];

  return (
    <>
      <SettingsPageHeader />
      <SettingsGroup>
        {fields.map((field) => (
          <SettingsRow key={field.key} label={field.label}>
            <Input
              className="w-[280px] text-meta"
              aria-label={field.label}
              value={form[field.key]}
              onChange={(event) => set(field.key)(event.target.value)}
            />
          </SettingsRow>
        ))}

        <SettingsRow label={t("settings.customAgent.env")}>
          <Input
            className="w-[280px] text-meta"
            aria-label={t("settings.customAgent.env")}
            placeholder="KEY=value"
            value={form.env}
            onChange={(event) => set("env")(event.target.value)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.customAgent.base")}>
          <Select
            value={form.baseAgent}
            onValueChange={(value) =>
              setForm((current) => ({
                ...current,
                baseAgent: value as BuiltinAgentId,
              }))
            }
          >
            <SelectTrigger
              aria-label={t("settings.customAgent.base")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {AGENT_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <div className="px-3 py-2">
          <CapabilityInheritance
            baseAgent={form.baseAgent}
            disabledCapabilities={form.disabledCapabilities ?? []}
            disabled={disabled}
            probe={probe}
            onChange={(disabledCapabilities) =>
              setForm((current) => ({ ...current, disabledCapabilities }))
            }
          />
        </div>
      </SettingsGroup>

      <div className="sticky bottom-0 z-10 -mb-(--space-section) flex items-center justify-between gap-2 bg-card py-3">
        <div>
          {existing && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setPendingDelete(true)}
            >
              {t("settings.customAgent.delete")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const id =
                existing?.id ??
                `custom:${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
              const agent = parseAgentForm(form, id);
              if (!agent) {
                toast.error(t("settings.customAgent.invalid"));
                return;
              }
              onSubmit(
                existing
                  ? custom.map((entry) =>
                      entry.id === existing.id ? agent : entry,
                    )
                  : [...custom, agent],
              );
            }}
          >
            {t("dialog.save")}
          </Button>
        </div>
      </div>

      <ResponsiveAlertDialog
        open={pendingDelete}
        onOpenChange={setPendingDelete}
      >
        <ResponsiveAlertDialogContent className="z-[var(--z-dialog)]">
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("settings.customAgent.deleteTitle", {
                name: existing?.label ?? "",
              })}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("dialog.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={() =>
                onSubmit(custom.filter((entry) => entry.id !== existing?.id))
              }
            >
              {t("settings.customAgent.delete")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
}
