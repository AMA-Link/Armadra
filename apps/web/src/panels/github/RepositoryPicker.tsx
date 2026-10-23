import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "@/app/preferences-store";
import { Field } from "../git/forms";

export interface RepositoryPickerProps {
  remoteUrl: string;
  onRemoteUrl: (value: string) => void;
  onResolve: () => void;
  busy: boolean;
}

/** 面板看的那个仓库：由一个 git 远端地址认出来（契约 §29.2）。 */
export function RepositoryPicker({
  remoteUrl,
  onRemoteUrl,
  onResolve,
  busy,
}: RepositoryPickerProps) {
  const t = useT();
  return (
    <form
      className="flex min-w-0 items-end gap-2 border-b border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && remoteUrl.trim()) onResolve();
      }}
    >
      <div className="min-w-0 flex-1">
        <Field label={t("github.remoteUrl")}>
          <Input
            value={remoteUrl}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onRemoteUrl(event.target.value)}
            size="sm"
            className="min-w-0"
          />
        </Field>
      </div>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className="shrink-0"
        disabled={busy || !remoteUrl.trim()}
      >
        {t("github.resolve")}
      </Button>
    </form>
  );
}
