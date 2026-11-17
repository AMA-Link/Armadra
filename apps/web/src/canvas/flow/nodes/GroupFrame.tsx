import type { CanvasNode } from "@armadra/shared";

import { GithubReferenceBadge } from "@/panels/github/GithubReferenceBadge";
import { frameBindingOf } from "../../frame-binding";
import { WorktreeBindingBadge } from "../overlays/WorktreeBindingBadge";

/**
 * 分组 = Frame 的框、标题与徽章：标题与色带、worktree 绑定徽章（G03）、GitHub
 * 关联徽标。Frame 自己就是一个 DOM 节点，徽章直接贴在它的标题行下面。
 */

/** 徽章相对 Frame 左上角的内缩，避开色带与标题。 */
const BADGE_INSET = 8;

/** 分组的框、标题与徽章（`board/GroupHost` 的内容）。 */
export function GroupFrame({
  node,
  selected,
}: {
  node: CanvasNode;
  selected: boolean;
}) {
  const bound = frameBindingOf(node) !== null;
  return (
    <>
      <div
        data-slot="group-frame"
        data-selected={selected ? "true" : undefined}
        className="canvas-group h-full w-full rounded-card border"
        style={{ borderColor: node.color }}
      >
        <div className="canvas-group-label" style={{ color: node.color }}>
          {node.title}
        </div>
        {/* GitHub 关联徽标：贴在标题行右侧，没有关联时不画任何像素。 */}
        <div
          data-slot="github-frame-references"
          className="canvas-group-badges absolute -top-[22px] right-1 flex gap-1"
        >
          <GithubReferenceBadge nodeId={node.id} checks />
        </div>
        {/* 绑定徽章（G03）在 Frame 内左上角：它有「重新创建 / 解绑」按钮，
            所以要自己收回指针事件，别被当成 Frame 的拖动。 */}
        {bound ? (
          <div
            className="nodrag nopan absolute"
            style={{
              left: BADGE_INSET,
              top: BADGE_INSET,
              maxWidth: `calc(100% - ${BADGE_INSET * 2}px)`,
            }}
          >
            <WorktreeBindingBadge node={node} />
          </div>
        ) : null}
      </div>
    </>
  );
}
