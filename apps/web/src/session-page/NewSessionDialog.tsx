import * as React from "react";

import { usePrestartOnOpen } from "@/acp/api";
import { preferredDriver } from "@/acp/driver";
import { agentLabel } from "@/agent/launch";
import { runtimeApi } from "@/api/client";
import { useEnabledAgents } from "@/app/use-agents";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { toast } from "@/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { useSessionPage } from "./store";

type Driver = "terminal" | "acp";

export function NewSessionDialog({
  open,
  onOpenChange,
  workspaceId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onStarted: () => void;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="sm:max-w-sm"
        aria-describedby={undefined}
      >
        <NewSessionForm
          workspaceId={workspaceId}
          onClose={() => onOpenChange(false)}
          onStarted={onStarted}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** 只在对话框打开时挂载：预热 Agent 适配器与表单状态都随打开而来。 */
function NewSessionForm({
  workspaceId,
  onClose,
  onStarted,
}: {
  workspaceId: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT();
  const agents = useEnabledAgents();
  usePrestartOnOpen(agents);
  const defaultAgentId = usePreferencesStore((state) => state.defaultAgentId);
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [choice, setChoice] = React.useState<Driver | null>(null);
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const agent =
    agents.find((item) => item.id === (agentId ?? defaultAgentId)) ?? agents[0];
  // 与画布新建菜单同一条规则：适配器装了、不是自带启动程序的自定义 Agent 才能走 ACP。
  const acpAvailable = agent ? preferredDriver(agent, "acp") === "acp" : false;
  const wanted = choice ?? (agent ? preferredDriver(agent) : "terminal");
  const driver: Driver =
    wanted === "acp" && !acpAvailable ? "terminal" : wanted;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agent || busy) return;
    setBusy(true);
    try {
      const name = title.trim();
      const started = await runtimeApi.startSession({
        workspaceId,
        agentId: agent.id,
        driver,
        ...(name === "" ? {} : { title: name }),
      });
      useSessionPage.getState().addStarting({
        nodeId: started.nodeId,
        boardId: started.boardId,
        title: started.title,
        agentId: agent.id,
        driver,
      });
      onStarted();
      onClose();
    } catch {
      toast.error(t("sessionPage.startFailed"));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{t("sessionPage.new")}</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>

      <div className="grid gap-1.5">
        <Label>{t("sessionPage.agent")}</Label>
        <Select
          value={agent?.id ?? ""}
          onValueChange={(value) => {
            setAgentId(value);
            setChoice(null);
          }}
          disabled={agents.length === 0}
        >
          <SelectTrigger
            aria-label={t("sessionPage.agent")}
            className="w-full min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {agents.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {agentLabel(item.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label>{t("sessionPage.driver")}</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          value={driver}
          aria-label={t("sessionPage.driver")}
          onValueChange={(value) => {
            if (value === "acp" || value === "terminal") setChoice(value);
          }}
        >
          <ToggleGroupItem value="acp" disabled={!acpAvailable}>
            {t("sessionPage.driver.acp")}
          </ToggleGroupItem>
          <ToggleGroupItem value="terminal">
            {t("sessionPage.driver.terminal")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="session-page-title">{t("sessionPage.name")}</Label>
        <Input
          id="session-page-title"
          value={title}
          maxLength={160}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <ResponsiveDialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("sessionPage.cancel")}
        </Button>
        <Button type="submit" disabled={!agent || busy} loading={busy}>
          {t("sessionPage.create")}
        </Button>
      </ResponsiveDialogFooter>
    </form>
  );
}
