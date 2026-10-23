import { Copy } from "lucide-react";
import { toast } from "@/ui/toast";

import { useT } from "../../../../app/preferences-store";
import { serverUpgradeCommands } from "../../../../updates/releases";
import { SettingsGroup } from "../../SettingsGroup";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/ui/input-group";

/**
 * 浏览器访问服务器壳、且 §64 有更新的版本时：两条可复制的升级命令（容器镜像
 * 标签与裸机 `upgrade`）。页面不替服务器执行任何东西。
 */
export function ServerUpgradeNotice({ version }: { version: string }) {
  const t = useT();
  const commands = serverUpgradeCommands(version);
  return (
    <SettingsGroup title={t("updates.newVersion", { version })}>
      <CommandRow
        label={t("updates.server.docker")}
        command={commands.docker}
      />
      <CommandRow
        label={t("updates.server.binary")}
        command={commands.binary}
      />
    </SettingsGroup>
  );
}

function CommandRow({ label, command }: { label: string; command: string }) {
  const t = useT();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("updates.copied"));
    } catch {
      toast.error(t("updates.copyFailed"));
    }
  };
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="text-body leading-5 text-foreground">{label}</span>
      <InputGroup>
        <InputGroupInput
          readOnly
          aria-label={label}
          value={command}
          className="font-mono text-meta"
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={t("updates.copy")}
            onClick={() => void copy()}
          >
            <Copy />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
