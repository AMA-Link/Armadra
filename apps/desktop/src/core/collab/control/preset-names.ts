import { presetNodeName } from "@armadra/shared";

import type { CanvasNode } from "../../canvas/document-types";
import { cleanTitle } from "./board";

/**
 * 控制动词建的终端 / Agent 节点叫什么（Armadra#969）。
 *
 * 给了 `--title` / `--name` 就照用；没给就取预设名（`@armadra/shared` 的
 * `presetNodeName`，与页面新建同一套词库），同时当名字（handle）写进节点数据。
 */
export interface NodeName {
  readonly title: string;
  /** 只有预设名才有；给了标题的节点不自动起名字。 */
  readonly handle?: string;
}

export function nameFor(
  explicit: string | undefined,
  nodes: readonly CanvasNode[],
  reserved: Iterable<string> = [],
): NodeName {
  if (explicit !== undefined) return { title: cleanTitle(explicit) };
  const preset = presetNodeName(nodes, reserved);
  return { title: cleanTitle(preset.title), handle: preset.handle };
}

/** 节点数据带上名字（有的话）。 */
export function withHandle<T extends object>(
  data: T,
  name: { readonly handle?: string | undefined },
): T {
  return name.handle === undefined ? data : { ...data, handle: name.handle };
}

/**
 * `team` 里没写标题（`preset !== undefined`）的成员换成预设名。同一队先到的
 * 先取，后面的跳过已经分出去的；画布重读之后再调一次，按新画布重新分。
 */
export function withPresetNames<
  R extends { readonly title: string; readonly preset?: NodeName | null },
>(roster: readonly R[], nodes: readonly CanvasNode[]): R[] {
  const reserved: string[] = [];
  return roster.map((role) => {
    if (role.preset === undefined) return role;
    const name = nameFor(undefined, nodes, reserved);
    reserved.push(name.handle!);
    return { ...role, title: name.title, preset: name };
  });
}
