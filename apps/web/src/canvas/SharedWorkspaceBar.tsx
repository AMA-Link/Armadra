import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useRealtimeStore } from "@/realtime/session";
import { useSource } from "@/sources/context";
import { originOf, shareRoleOf } from "@/sources/origin";
import { initialOf, ownerNameOf } from "@/sources/workspace-groups";
import { useCanvasStore } from "@/store/canvas-store";
import { currentPresence, presenceClientId } from "@/store/canvas/presence";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { memberColorVar } from "@/ui/member-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/** 头像最多画几个，其余收成「+N」。 */
export const MAX_MEMBERS = 4;

interface Member {
  readonly key: string;
  readonly name: string;
  readonly color: string;
}

/** 在线的其他人：实时板按人（同一个人的几个窗口算一个），否则按设备。 */
function useMembers(): readonly Member[] {
  const peers = useRealtimeStore((view) => view.peers);
  const presence = useCanvasStore(currentPresence);
  if (peers.length > 0) {
    const seen = new Map<string, Member>();
    for (const peer of peers) {
      const key = peer.state.principalId || String(peer.clientId);
      if (!seen.has(key))
        seen.set(key, {
          key,
          name: peer.state.name,
          color: memberColorVar(peer.state.color),
        });
    }
    return [...seen.values()];
  }
  const me = presenceClientId();
  return (presence?.clients ?? [])
    .filter((client) => client.clientId !== me)
    .map((client, index) => ({
      key: client.clientId,
      name: client.deviceName,
      color: memberColorVar(index + 2),
    }));
}

/** 打开着的是别人分享来的工作空间（顶栏那一排要不要给它留位置）。 */
export function useSharedWorkspaceOpen(): boolean {
  const workspace = useCanvasStore((state) => state.workspace);
  const sourceId = useCanvasStore((state) => state.sourceId);
  const connection = useSource(sourceId);
  return (
    workspace !== null &&
    connection !== undefined &&
    originOf(connection.descriptor) === "shared"
  );
}

/**
 * 画布顶栏的分享标识（#301）：打开的是别人分享来的工作空间时，写「<主人> 的
 * <工作空间> · <权限>」，后面是在线的其他人。打开的是我自己的电脑时什么也
 * 不画。位置由挂它的地方定。
 */
export function SharedWorkspaceBar({ className }: { className?: string }) {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const sourceId = useCanvasStore((state) => state.sourceId);
  const connection = useSource(sourceId);
  const members = useMembers();
  if (
    workspace === null ||
    connection === undefined ||
    originOf(connection.descriptor) !== "shared"
  )
    return null;
  const owner = ownerNameOf(connection);
  const role = t(`workspaceGroups.role.${shareRoleOf(connection.descriptor)}`);
  const visible = members.slice(0, MAX_MEMBERS);
  const hidden = members.length - visible.length;
  return (
    <div
      data-shared-workspace-bar
      className={cn(
        "flex h-(--row-h) min-w-0 items-center gap-2 text-body",
        className,
      )}
    >
      <p className="min-w-0 truncate">
        <span>
          {t("workspaceGroups.ownerWorkspace", {
            owner,
            workspace: workspace.name,
          })}
        </span>
        <span aria-hidden className="text-muted-foreground">
          {" · "}
        </span>
        <span className="text-muted-foreground">{role}</span>
      </p>
      {visible.length > 0 && (
        <div
          role="group"
          aria-label={t("workspaceGroups.members")}
          className="flex shrink-0 items-center -space-x-1"
        >
          {visible.map((member) => (
            <Tooltip key={member.key}>
              <TooltipTrigger asChild>
                <Avatar
                  size="sm"
                  aria-label={member.name}
                  className="size-5 after:hidden data-[size=sm]:size-5"
                  style={{ boxShadow: `0 0 0 2px ${member.color}` }}
                >
                  <AvatarFallback className="bg-card text-caption font-medium text-foreground">
                    {initialOf(member.name)}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent side="bottom">{member.name}</TooltipContent>
            </Tooltip>
          ))}
          {hidden > 0 && (
            <span
              aria-label={t("realtime.presence.more", { count: hidden })}
              className="pl-2 text-caption text-muted-foreground tabular-nums"
            >
              +{hidden}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
