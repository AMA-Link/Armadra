import { type CanvasNode, isPresetTitle } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { nodeName, requestNodeNames } from "./node-names";
import { Button } from "@/ui/button";

/**
 * 节点头上的 `@名字`（设计 §2.3）。
 *
 * 没起名就什么都不画：名字是给协作用的，一块只有一个 Agent 的画布不需要它，
 * 而一个「未命名」占位会让每个节点头都多一个词。点一下就是改名——这个徽标是
 * 名字在界面上唯一的常驻位置，所以它也该是改名最近的那扇门。
 */
export function NodeNameBadge({ node }: { node: CanvasNode }) {
  const t = useT();
  const name = nodeName(node);
  if (name === undefined) return null;
  // 标题就是这个名字（新建时的预设名 `Atlas` / `atlas`，或者人把两者起成一样）
  // 时不再画一遍：同一个词在头部出现两次只是噪音。改名入口还在 `···` 里。
  if (sameAsTitle(node.title, name)) return null;
  return (
    <Badge
      asChild
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      data-no-drag="true"
    >
      <Button
        variant="ghost"
        size="xs"
        type="button"
        aria-label={t("node.name.edit")}
        onClick={(event) => {
          event.stopPropagation();
          requestNodeNames([node.id]);
        }}
      >
        @{name}
      </Button>
    </Badge>
  );
}

function sameAsTitle(title: string, name: string): boolean {
  return title.trim().toLowerCase() === name || isPresetTitle(title, name);
}
