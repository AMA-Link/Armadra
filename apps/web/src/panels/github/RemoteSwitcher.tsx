import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";
import {
  FORGE_NAMES,
  type WorkspaceRemote,
  type WorkspaceRepository,
} from "../../api/forge";

/** 选「输入远端地址」的值：不会和 git remote 名撞（remote 名不含 `/`）。 */
export const MANUAL_REMOTE = "/manual";

function repoLabel(remote: WorkspaceRemote): string {
  const repository = remote.detection?.repository;
  return repository ? `${repository.owner}/${repository.name}` : remote.url;
}

/** 缺令牌：识别出了平台、但没有可用的登录。 */
function missingToken(remote: WorkspaceRemote): boolean {
  return remote.detection !== null && !remote.detection.credential;
}

function Dot({ remote }: { remote: WorkspaceRemote }) {
  const t = useT();
  if (!missingToken(remote)) return null;
  return (
    <span
      role="img"
      aria-label={t("forge.remote.noToken")}
      data-slot="forge-remote-no-token"
      className="inline-block size-2 shrink-0 rounded-full bg-warn"
    />
  );
}

/**
 * 面板顶部的仓库按钮与下拉：列出工作空间的各个 remote（名字、仓库、主机、平台、
 * 令牌来源，缺令牌带橙点），末项「输入远端地址」回到手填。
 */
export function RemoteSwitcher({
  repository,
  value,
  onChange,
}: {
  repository: WorkspaceRepository;
  /** remote 名，或 {@link MANUAL_REMOTE}。 */
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const current = repository.remotes.find((remote) => remote.name === value);
  return (
    <div
      className="min-w-0 border-b border-border p-3"
      data-slot="forge-remote-switcher"
    >
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          size="sm"
          className="w-full min-w-0"
          aria-label={t("forge.title")}
        >
          <SelectValue>
            <span className="flex min-w-0 items-center gap-2">
              {current && <Dot remote={current} />}
              <span className="min-w-0 truncate font-medium">
                {current ? repoLabel(current) : t("forge.addRemote")}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {repository.remotes.map((remote) => (
            <SelectItem key={remote.name} value={remote.name}>
              <span
                className="flex min-w-0 items-center gap-2"
                data-remote={remote.name}
              >
                <Dot remote={remote} />
                <span className="shrink-0 font-mono text-muted-foreground">
                  {remote.name}
                </span>
                <span className="min-w-0 truncate">{repoLabel(remote)}</span>
                {remote.detection && (
                  <>
                    <span className="shrink-0 text-meta text-muted-foreground">
                      {remote.detection.repository.host}
                    </span>
                    {remote.detection.forge && (
                      <Badge variant="outline" size="sm">
                        {FORGE_NAMES[remote.detection.forge] ??
                          remote.detection.forge}
                      </Badge>
                    )}
                    {remote.detection.credentialSource && (
                      <span className="shrink-0 text-meta text-muted-foreground">
                        {t(`forge.source.${remote.detection.credentialSource}`)}
                      </span>
                    )}
                  </>
                )}
              </span>
            </SelectItem>
          ))}
          <SelectItem value={MANUAL_REMOTE}>{t("forge.addRemote")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
